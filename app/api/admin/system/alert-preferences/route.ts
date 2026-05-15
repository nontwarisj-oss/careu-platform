// GET  /api/admin/system/alert-preferences — list global + per-branch rows.
// POST /api/admin/system/alert-preferences — upsert one scope's row.
// POST { branchId, delete:true }            — delete a per-branch row.
//
// Phase 23. Owner / hq_admin only. Controls WHO receives routed
// alerts, the severity floor, alert quiet hours, and weekly-digest
// opt-in — per branch, with a global default.
//
// Audited to cron_heartbeat_logs (cron_name='settings-edit') the same
// way /api/admin/system/guardrails audits its edits.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import { __resetAlertPreferencesCache } from "@/lib/alertPreferences";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    .from("alert_preferences")
    .select(
      "id, branch_id, recipients, min_severity, quiet_hours_start_h, quiet_hours_end_h, enabled, digest_enabled, updated_at"
    )
    .order("branch_id", { ascending: true, nullsFirst: true });
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, rows: res.data ?? [] });
}

type Body = {
  branchId?: string | null;
  recipients?: string[];
  minSeverity?: "warning" | "critical";
  quietHoursStartH?: number | null;
  quietHoursEndH?: number | null;
  enabled?: boolean;
  digestEnabled?: boolean;
  delete?: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanHour(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const h = Math.trunc(n);
  return h >= 0 && h <= 23 ? h : null;
}

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "alert-prefs-write",
    limit: 40,
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

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  // Find the existing row for this scope.
  const findQ = admin.from("alert_preferences").select("id");
  const existing = await (branchId === null
    ? findQ.is("branch_id", null)
    : findQ.eq("branch_id", branchId)
  )
    .limit(1)
    .maybeSingle();
  const existingId = (existing.data as { id: string } | null)?.id ?? null;

  // Delete path.
  if (body.delete === true) {
    if (branchId === null) {
      return NextResponse.json(
        { ok: false, reason: "ลบ global default ไม่ได้ — แก้ไขแทน" },
        { status: 400 }
      );
    }
    if (existingId) {
      const del = await admin
        .from("alert_preferences")
        .delete()
        .eq("id", existingId);
      if (del.error) {
        return NextResponse.json(
          { ok: false, reason: del.error.message },
          { status: 500 }
        );
      }
    }
    __resetAlertPreferencesCache();
    await audit(admin, actorId, ip, { branchId, action: "delete" });
    return NextResponse.json({ ok: true, deleted: Boolean(existingId) });
  }

  // Validate recipients.
  const recipients = Array.isArray(body.recipients)
    ? Array.from(
        new Set(
          body.recipients
            .map((r) => String(r).trim().toLowerCase())
            .filter((r) => r.length > 0)
        )
      )
    : [];
  const badEmail = recipients.find((r) => !EMAIL_RE.test(r));
  if (badEmail) {
    return NextResponse.json(
      { ok: false, reason: `อีเมลไม่ถูกต้อง: ${badEmail}` },
      { status: 400 }
    );
  }

  const payload = {
    branch_id: branchId,
    recipients,
    min_severity:
      body.minSeverity === "critical" ? "critical" : "warning",
    quiet_hours_start_h: cleanHour(body.quietHoursStartH),
    quiet_hours_end_h: cleanHour(body.quietHoursEndH),
    enabled: body.enabled !== false,
    digest_enabled: body.digestEnabled !== false,
    updated_at: new Date().toISOString(),
    updated_by: actorId,
  };

  if (existingId) {
    const upd = await admin
      .from("alert_preferences")
      .update(payload)
      .eq("id", existingId);
    if (upd.error) {
      return NextResponse.json(
        { ok: false, reason: upd.error.message },
        { status: 500 }
      );
    }
  } else {
    const ins = await admin.from("alert_preferences").insert(payload);
    if (ins.error) {
      return NextResponse.json(
        { ok: false, reason: ins.error.message },
        { status: 500 }
      );
    }
  }

  __resetAlertPreferencesCache();
  await audit(admin, actorId, ip, {
    branchId,
    action: existingId ? "update" : "insert",
    recipients: recipients.length,
  });
  return NextResponse.json({ ok: true });
}

async function audit(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  actorId: string,
  ip: string,
  detail: Record<string, unknown>
): Promise<void> {
  try {
    const now = new Date().toISOString();
    await admin.from("cron_heartbeat_logs").insert({
      cron_name: "settings-edit",
      started_at: now,
      finished_at: now,
      duration_ms: 0,
      success: true,
      rows_processed: 1,
      details: {
        kind: "alert_preferences",
        actorId,
        ip: ip === "unknown" ? null : ip,
        ...detail,
      },
    });
  } catch {
    // best-effort
  }
}
