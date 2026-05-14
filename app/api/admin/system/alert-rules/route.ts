// GET  /api/admin/system/alert-rules — list all rules.
// POST /api/admin/system/alert-rules — create / update / delete a rule.
//
// Owner / hq_admin only. The rules are evaluated by
// lib/workerHealth.ts::computeWorkerHealth on every dashboard read.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_METRICS = new Set([
  "delivery_success_pct",
  "dead_letter_count",
  "queue_age_minutes",
  "failure_count",
  "cron_silence_minutes",
]);
const ALLOWED_COMPARISONS = new Set(["gt", "lt"]);
const ALLOWED_SEVERITIES = new Set(["warning", "critical"]);

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
    .from("communication_alert_rules")
    .select(
      "id, name, metric, comparison, threshold, window_minutes, severity, branch_id, enabled, notes, updated_at, created_at"
    )
    .order("created_at", { ascending: false });
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, rules: res.data ?? [] });
}

type RuleInput = {
  id?: string;
  name?: string;
  metric?: string;
  comparison?: string;
  threshold?: number;
  windowMinutes?: number;
  severity?: string;
  branchId?: string | null;
  enabled?: boolean;
  notes?: string | null;
  /** When set to true, deletes the row instead of upserting. */
  delete?: boolean;
};

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "alert-rules",
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

  let body: RuleInput;
  try {
    body = (await req.json()) as RuleInput;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  if (body.delete) {
    if (!body.id) {
      return NextResponse.json(
        { ok: false, reason: "id required for delete" },
        { status: 400 }
      );
    }
    const del = await admin
      .from("communication_alert_rules")
      .delete()
      .eq("id", body.id);
    if (del.error) {
      return NextResponse.json(
        { ok: false, reason: del.error.message },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true, action: "deleted", id: body.id });
  }

  if (
    !body.name ||
    !body.metric ||
    !body.comparison ||
    typeof body.threshold !== "number"
  ) {
    return NextResponse.json(
      { ok: false, reason: "name + metric + comparison + threshold required" },
      { status: 400 }
    );
  }
  if (!ALLOWED_METRICS.has(body.metric)) {
    return NextResponse.json(
      { ok: false, reason: `metric must be one of ${Array.from(ALLOWED_METRICS).join(", ")}` },
      { status: 400 }
    );
  }
  if (!ALLOWED_COMPARISONS.has(body.comparison)) {
    return NextResponse.json(
      { ok: false, reason: "comparison must be 'gt' or 'lt'" },
      { status: 400 }
    );
  }
  const severity = body.severity ?? "warning";
  if (!ALLOWED_SEVERITIES.has(severity)) {
    return NextResponse.json(
      { ok: false, reason: "severity must be 'warning' or 'critical'" },
      { status: 400 }
    );
  }

  const payload = {
    name: body.name.trim(),
    metric: body.metric,
    comparison: body.comparison,
    threshold: body.threshold,
    window_minutes: body.windowMinutes ?? 60,
    severity,
    branch_id: body.branchId ?? null,
    enabled: body.enabled ?? true,
    notes: body.notes ?? null,
    created_by: actorId,
  };

  if (body.id) {
    const upd = await admin
      .from("communication_alert_rules")
      .update(payload)
      .eq("id", body.id);
    if (upd.error) {
      return NextResponse.json(
        { ok: false, reason: upd.error.message },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true, action: "updated", id: body.id });
  } else {
    const ins = await admin
      .from("communication_alert_rules")
      .insert(payload)
      .select("id")
      .single();
    if (ins.error || !ins.data) {
      return NextResponse.json(
        { ok: false, reason: ins.error?.message ?? "Insert failed" },
        { status: 500 }
      );
    }
    return NextResponse.json({
      ok: true,
      action: "created",
      id: (ins.data as { id: string }).id,
    });
  }
}
