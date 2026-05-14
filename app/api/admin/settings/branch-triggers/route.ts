// GET  /api/admin/settings/branch-triggers              — list all overrides.
// POST /api/admin/settings/branch-triggers              — upsert / delete.
//
// Owner/HQ writes any branch's row. Branch_manager writes their own
// branch only — enforced via RLS + here at the route layer too.
//
// Audit: every change writes a cron_heartbeat_logs row with
// cron_name='settings-edit' so the operator can see who changed
// what + when in the workers dashboard.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import {
  OVERRIDE_KEYS,
  __resetBranchOverridesCache,
} from "@/lib/branchTriggerOverrides";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EDITABLE_KEYS = new Set([
  ...OVERRIDE_KEYS,
  // Phase 20 additions — also editable per branch.
  "birthday_trigger_enabled",
]);

export async function GET() {
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
  ]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;
  const branchCode = profile.branchCode ?? null;
  const isAll = profile.role === "owner" || profile.role === "hq_admin";

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  let q = admin
    .from("branch_trigger_overrides")
    .select("id, branch_id, key, value, notes, updated_at, updated_by")
    .order("branch_id", { ascending: true })
    .order("key", { ascending: true });
  if (!isAll && branchCode) q = q.eq("branch_id", branchCode);
  const res = await q;
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({
    ok: true,
    rows: res.data ?? [],
    editableKeys: Array.from(EDITABLE_KEYS),
  });
}

type Body = {
  branchId?: string;
  /** key → value | null (null deletes the override) */
  values?: Record<string, unknown>;
  reason?: string;
};

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "branch-triggers-write",
    limit: 30,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "ลองมากเกินไป" },
      { status: 429 }
    );
  }
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
  ]);
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
  const branchId = (body.branchId ?? "").trim();
  if (!branchId) {
    return NextResponse.json(
      { ok: false, reason: "branchId required" },
      { status: 400 }
    );
  }
  // Branch access — owner/HQ pass; branch_manager must own.
  const guard = await requireBranchAccess(branchId);
  if (guard instanceof NextResponse) return guard;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  const values = body.values ?? {};
  const changes: Array<{
    key: string;
    action: "insert" | "update" | "delete" | "noop";
  }> = [];
  const errors: Array<{ key: string; reason: string }> = [];

  for (const [key, value] of Object.entries(values)) {
    if (!EDITABLE_KEYS.has(key)) continue;
    const existing = await admin
      .from("branch_trigger_overrides")
      .select("id")
      .eq("branch_id", branchId)
      .eq("key", key)
      .limit(1)
      .maybeSingle();
    const row = existing.data as { id: string } | null;

    if (value === null) {
      if (row) {
        const del = await admin
          .from("branch_trigger_overrides")
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
        .from("branch_trigger_overrides")
        .update({ value, updated_by: actorId })
        .eq("id", row.id);
      if (upd.error) errors.push({ key, reason: upd.error.message });
      else changes.push({ key, action: "update" });
    } else {
      const ins = await admin
        .from("branch_trigger_overrides")
        .insert({ branch_id: branchId, key, value, updated_by: actorId });
      if (ins.error) errors.push({ key, reason: ins.error.message });
      else changes.push({ key, action: "insert" });
    }
  }

  __resetBranchOverridesCache();

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
        kind: "branch_trigger_overrides",
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
