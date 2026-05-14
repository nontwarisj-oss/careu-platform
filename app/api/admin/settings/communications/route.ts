// GET  /api/admin/settings/communications?branch=<slug>
// POST /api/admin/settings/communications  { branch, values }
//
// Reads / writes per-branch feature flag rows.
//
// Read mode: returns the effective values for a given branch — for
// each known flag, the branch-scoped row wins over the global row;
// global wins over fallback. The UI uses this to render the form.
//
// Write mode: upserts the branch-scoped row for each flag in the
// values payload. Empty / missing keys leave the existing override
// untouched. To "revert to global", the operator sends value=null
// for that key (encoded as JSON `null`) which deletes the override
// row.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import { __resetFeatureFlagsCache, FLAG_KEYS } from "@/lib/featureFlags";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EDITABLE_KEYS = new Set<string>([
  FLAG_KEYS.ENABLE_SMS,
  FLAG_KEYS.ENABLE_LINE_BROADCAST,
  FLAG_KEYS.ENABLE_SCHEDULED_BROADCASTS,
  FLAG_KEYS.ENABLE_CROSS_BRANCH_BROADCASTS,
  FLAG_KEYS.BROADCAST_MAX_TARGETS_PER_JOB,
  FLAG_KEYS.BROADCAST_QUIET_HOURS_START_H,
  FLAG_KEYS.BROADCAST_QUIET_HOURS_END_H,
  FLAG_KEYS.BROADCAST_DEDUP_WINDOW_HOURS,
]);

export async function GET(req: Request) {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const url = new URL(req.url);
  const branch = url.searchParams.get("branch");

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  // Return ALL flag rows so the UI can show effective values + which
  // are branch-scoped vs global.
  const res = await admin
    .from("feature_flags")
    .select("key, value, branch_id, notes, updated_at, updated_by")
    .order("key", { ascending: true });
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({
    ok: true,
    branch: branch ?? null,
    rows: res.data ?? [],
    editableKeys: Array.from(EDITABLE_KEYS),
  });
}

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "settings-communications",
    limit: 30,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "ลองมากเกินไป" },
      { status: 429 }
    );
  }

  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const actorId = guarded.profile.id;

  type Body = {
    /** null = global override, string = per-branch override. */
    branchId?: string | null;
    /** key → value | null (null deletes the override). */
    values?: Record<string, unknown>;
    /** Optional free-text reason for the audit trail. */
    reason?: string;
  };
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const branchId = body.branchId ?? null;
  const values = body.values ?? {};

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  const changes: Array<{
    key: string;
    action: "update" | "insert" | "delete" | "noop";
    value: unknown;
  }> = [];
  const errors: Array<{ key: string; reason: string }> = [];

  for (const [key, value] of Object.entries(values)) {
    if (!EDITABLE_KEYS.has(key)) continue;

    // Find the existing row with the EXACT (key, branch_id) we're
    // managing. branchId IS NULL vs branchId = X are distinct rows.
    const existingQ = admin
      .from("feature_flags")
      .select("id, value")
      .eq("key", key);
    const existing = await (branchId === null
      ? existingQ.is("branch_id", null)
      : existingQ.eq("branch_id", branchId)
    )
      .limit(1)
      .maybeSingle();
    const existingRow = existing.data as
      | { id: string; value: unknown }
      | null;

    if (value === null) {
      // Caller wants to revert to the global value — delete the
      // branch override. (Deleting the global row would leave the
      // fallback constants in lib/featureFlags.ts; we allow that
      // too.)
      if (existingRow) {
        const del = await admin
          .from("feature_flags")
          .delete()
          .eq("id", existingRow.id);
        if (del.error) {
          errors.push({ key, reason: del.error.message });
        } else {
          changes.push({ key, action: "delete", value: null });
        }
      } else {
        changes.push({ key, action: "noop", value: null });
      }
      continue;
    }

    if (existingRow) {
      const upd = await admin
        .from("feature_flags")
        .update({
          value,
          updated_by: actorId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingRow.id);
      if (upd.error) {
        errors.push({ key, reason: upd.error.message });
      } else {
        changes.push({ key, action: "update", value });
      }
    } else {
      const ins = await admin.from("feature_flags").insert({
        key,
        value,
        branch_id: branchId,
        updated_by: actorId,
      });
      if (ins.error) {
        errors.push({ key, reason: ins.error.message });
      } else {
        changes.push({ key, action: "insert", value });
      }
    }
  }

  // Invalidate the in-process cache so the next request picks up the
  // new values without waiting 60s.
  __resetFeatureFlagsCache();

  return NextResponse.json({
    ok: errors.length === 0,
    changes,
    errors,
    actorId,
    branchId,
  });
}
