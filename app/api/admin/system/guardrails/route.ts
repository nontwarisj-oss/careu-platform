// GET  /api/admin/system/guardrails — list all rows.
// POST /api/admin/system/guardrails — upsert / delete one row.
// POST /api/admin/system/guardrails/emergency-stop — convenience
//        toggle (handled via the regular POST with key=
//        'global_emergency_stop').
//
// Owner / hq_admin only. Branch-scoped rows are accepted (operator
// can cap per-branch sends without flipping the global toggle).

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import {
  GUARDRAIL_KEYS,
  __resetGuardrailsCache,
} from "@/lib/engagementGuardrails";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EDITABLE = new Set<string>(GUARDRAIL_KEYS);

export async function GET() {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  const res = await admin
    .from("engagement_guardrails")
    .select("id, key, value, branch_id, notes, updated_at, updated_by")
    .order("branch_id", { ascending: true, nullsFirst: true })
    .order("key", { ascending: true });
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({
    ok: true,
    rows: res.data ?? [],
    editableKeys: Array.from(EDITABLE),
  });
}

type Body = {
  /** null = global, string = per-branch */
  branchId?: string | null;
  /** key → value | null (null deletes the row) */
  values?: Record<string, unknown>;
  reason?: string;
};

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "guardrails-write",
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
    action: "insert" | "update" | "delete" | "noop";
  }> = [];
  const errors: Array<{ key: string; reason: string }> = [];

  for (const [key, value] of Object.entries(values)) {
    if (!EDITABLE.has(key)) continue;
    const existingQ = admin
      .from("engagement_guardrails")
      .select("id")
      .eq("key", key);
    const existing = await (branchId === null
      ? existingQ.is("branch_id", null)
      : existingQ.eq("branch_id", branchId)
    )
      .limit(1)
      .maybeSingle();
    const row = existing.data as { id: string } | null;

    if (value === null) {
      if (row) {
        const del = await admin
          .from("engagement_guardrails")
          .delete()
          .eq("id", row.id);
        if (del.error) errors.push({ key, reason: del.error.message });
        else changes.push({ key, action: "delete" });
      } else {
        changes.push({ key, action: "noop" });
      }
      continue;
    }

    if (row) {
      const upd = await admin
        .from("engagement_guardrails")
        .update({ value, updated_by: actorId })
        .eq("id", row.id);
      if (upd.error) errors.push({ key, reason: upd.error.message });
      else changes.push({ key, action: "update" });
    } else {
      const ins = await admin.from("engagement_guardrails").insert({
        key,
        value,
        branch_id: branchId,
        updated_by: actorId,
      });
      if (ins.error) errors.push({ key, reason: ins.error.message });
      else changes.push({ key, action: "insert" });
    }
  }

  __resetGuardrailsCache();

  // Audit row.
  try {
    await admin.from("cron_heartbeat_logs").insert({
      cron_name: "settings-edit",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 0,
      success: errors.length === 0,
      rows_processed: changes.filter((c) => c.action !== "noop").length,
      details: {
        kind: "engagement_guardrails",
        branchId,
        changes,
        errors,
        actorId,
        ip: ip === "unknown" ? null : ip,
        reason: body.reason ?? null,
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({
    ok: errors.length === 0,
    changes,
    errors,
  });
}
