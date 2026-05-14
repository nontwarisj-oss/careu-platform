// GET    /api/admin/crm/broadcasts/[id]/jobs/[jobId]        — fetch one send_job + counts + recent attempts.
// PATCH  /api/admin/crm/broadcasts/[id]/jobs/[jobId]        — pause / resume / cancel.
//
// Allowed transitions:
//   queued     → cancelled  | paused
//   processing → cancelled  | paused
//   paused     → processing (resume) | cancelled
//   completed  → (nothing)
//   cancelled  → (nothing)
//   failed     → (nothing)
//
// Cancelling a job marks the row cancelled + sets all 'pending'
// targets to 'skipped' with reason='job cancelled'. Already-
// dispatched notifications are NOT recalled — they're in the queue.
// Operator can separately use /api/admin/notifications/cancel for
// individual queue rows.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PatchInput = {
  action?: "pause" | "resume" | "cancel";
  reason?: string;
};

const PAUSE_FROM = new Set(["queued", "processing"]);
const RESUME_FROM = new Set(["paused"]);
const CANCEL_FROM = new Set(["queued", "processing", "paused"]);

async function loadJob(jobId: string) {
  const admin = getSupabaseAdmin();
  if (!admin) return { err: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" as const };
  const res = await admin
    .from("broadcast_send_jobs")
    .select(
      "id, draft_id, status, branch_id, channels, expected_total, started_at, scheduled_for, mode, created_at, completed_at, paused_at, cancelled_at, failure_reason"
    )
    .eq("id", jobId)
    .maybeSingle();
  if (res.error || !res.data) {
    return { err: res.error?.message ?? "ไม่พบ send_job" };
  }
  return { data: res.data as Record<string, unknown> };
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string; jobId: string }> }
) {
  const guarded = await requireRole(["owner", "hq_admin", "branch_manager"]);
  if (guarded instanceof NextResponse) return guarded;

  const { id: draftId, jobId } = await context.params;
  const job = await loadJob(jobId);
  if ("err" in job) {
    return NextResponse.json({ ok: false, reason: job.err }, { status: 404 });
  }
  if (String(job.data.draft_id) !== draftId) {
    return NextResponse.json(
      { ok: false, reason: "job ไม่ตรงกับ draft" },
      { status: 400 }
    );
  }
  const branchId = job.data.branch_id as string | null;
  if (branchId) {
    const branchGuard = await requireBranchAccess(branchId);
    if (branchGuard instanceof NextResponse) return branchGuard;
  }

  const admin = getSupabaseAdmin()!;
  // Per-status counts so the UI renders progress without counting on
  // the client.
  const statuses = ["pending", "dispatched", "skipped", "dead_letter"];
  const counts: Record<string, number> = {};
  for (const s of statuses) {
    const r = await admin
      .from("broadcast_send_targets")
      .select("id", { count: "exact", head: true })
      .eq("send_job_id", jobId)
      .eq("status", s);
    counts[s] = r.count ?? 0;
  }
  const channelBreakdown: Record<string, { dispatched: number; skipped: number; pending: number }> = {};
  const channels = (job.data.channels as string[]) ?? [];
  for (const ch of channels) {
    const dispatched = await admin
      .from("broadcast_send_targets")
      .select("id", { count: "exact", head: true })
      .eq("send_job_id", jobId)
      .eq("channel", ch)
      .eq("status", "dispatched");
    const skipped = await admin
      .from("broadcast_send_targets")
      .select("id", { count: "exact", head: true })
      .eq("send_job_id", jobId)
      .eq("channel", ch)
      .eq("status", "skipped");
    const pending = await admin
      .from("broadcast_send_targets")
      .select("id", { count: "exact", head: true })
      .eq("send_job_id", jobId)
      .eq("channel", ch)
      .eq("status", "pending");
    channelBreakdown[ch] = {
      dispatched: dispatched.count ?? 0,
      skipped: skipped.count ?? 0,
      pending: pending.count ?? 0,
    };
  }

  // Recent attempts log (most recent 20).
  const attempts = await admin
    .from("broadcast_send_attempts")
    .select(
      "id, targets_processed, dispatched_count, skipped_count, failed_count, blocked_reason, duration_ms, started_at, finished_at"
    )
    .eq("send_job_id", jobId)
    .order("started_at", { ascending: false })
    .limit(20);

  // Recent metrics rows.
  const metrics = await admin
    .from("broadcast_metrics_daily")
    .select(
      "metric_date, channel, sent_count, skipped_count, deduped_count, opted_out_count, delivered_count, failed_count"
    )
    .eq("send_job_id", jobId)
    .order("metric_date", { ascending: false })
    .limit(10);

  // Sample of recently dispatched targets — useful for "did the
  // first 10 customers get the right thing?".
  const sample = await admin
    .from("broadcast_send_targets")
    .select(
      "id, customer_id, channel, status, skip_reason, notification_id, processed_at"
    )
    .eq("send_job_id", jobId)
    .order("processed_at", { ascending: false })
    .limit(20);

  return NextResponse.json({
    ok: true,
    job: job.data,
    counts,
    channelBreakdown,
    attempts: attempts.data ?? [],
    metrics: metrics.data ?? [],
    sample: sample.data ?? [],
  });
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string; jobId: string }> }
) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "broadcast-job-action",
    limit: 30,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "ลองมากเกินไป" },
      { status: 429 }
    );
  }

  const guarded = await requireRole(["owner", "hq_admin", "branch_manager"]);
  if (guarded instanceof NextResponse) return guarded;
  const actorId = guarded.profile.id;

  const { id: draftId, jobId } = await context.params;
  let body: PatchInput;
  try {
    body = (await req.json()) as PatchInput;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const action = body.action;
  if (!action || !["pause", "resume", "cancel"].includes(action)) {
    return NextResponse.json(
      { ok: false, reason: "action ต้องเป็น pause / resume / cancel" },
      { status: 400 }
    );
  }

  const job = await loadJob(jobId);
  if ("err" in job) {
    return NextResponse.json({ ok: false, reason: job.err }, { status: 404 });
  }
  if (String(job.data.draft_id) !== draftId) {
    return NextResponse.json(
      { ok: false, reason: "job ไม่ตรงกับ draft" },
      { status: 400 }
    );
  }
  const branchId = job.data.branch_id as string | null;
  if (branchId) {
    const branchGuard = await requireBranchAccess(branchId);
    if (branchGuard instanceof NextResponse) return branchGuard;
  }

  const status = String(job.data.status);
  const admin = getSupabaseAdmin()!;
  const now = new Date().toISOString();

  if (action === "pause") {
    if (!PAUSE_FROM.has(status)) {
      return NextResponse.json(
        { ok: false, reason: `cannot pause from status ${status}` },
        { status: 409 }
      );
    }
    const upd = await admin
      .from("broadcast_send_jobs")
      .update({
        status: "paused",
        paused_at: now,
        paused_by: actorId,
      })
      .eq("id", jobId)
      .in("status", Array.from(PAUSE_FROM));
    if (upd.error) {
      return NextResponse.json(
        { ok: false, reason: upd.error.message },
        { status: 500 }
      );
    }
    await admin.from("broadcast_audit_log").insert({
      draft_id: draftId,
      action: "send_paused",
      actor_id: actorId,
      before_value: { status },
      after_value: { send_job_id: jobId },
      reason: body.reason ?? null,
      request_ip: ip === "unknown" ? null : ip,
    });
    return NextResponse.json({ ok: true, status: "paused" });
  }

  if (action === "resume") {
    if (!RESUME_FROM.has(status)) {
      return NextResponse.json(
        { ok: false, reason: `cannot resume from status ${status}` },
        { status: 409 }
      );
    }
    const upd = await admin
      .from("broadcast_send_jobs")
      .update({
        status: "processing",
        paused_at: null,
        paused_by: null,
      })
      .eq("id", jobId)
      .eq("status", "paused");
    if (upd.error) {
      return NextResponse.json(
        { ok: false, reason: upd.error.message },
        { status: 500 }
      );
    }
    await admin.from("broadcast_audit_log").insert({
      draft_id: draftId,
      action: "send_resumed",
      actor_id: actorId,
      before_value: { status },
      after_value: { send_job_id: jobId },
      reason: body.reason ?? null,
      request_ip: ip === "unknown" ? null : ip,
    });
    return NextResponse.json({ ok: true, status: "processing" });
  }

  if (action === "cancel") {
    if (!CANCEL_FROM.has(status)) {
      return NextResponse.json(
        { ok: false, reason: `cannot cancel from status ${status}` },
        { status: 409 }
      );
    }
    // Skip all remaining pending targets.
    await admin
      .from("broadcast_send_targets")
      .update({
        status: "skipped",
        skip_reason: "job cancelled by operator",
        processed_at: now,
      })
      .eq("send_job_id", jobId)
      .eq("status", "pending");
    const upd = await admin
      .from("broadcast_send_jobs")
      .update({
        status: "cancelled",
        cancelled_at: now,
        cancelled_by: actorId,
      })
      .eq("id", jobId)
      .in("status", Array.from(CANCEL_FROM));
    if (upd.error) {
      return NextResponse.json(
        { ok: false, reason: upd.error.message },
        { status: 500 }
      );
    }
    await admin.from("broadcast_audit_log").insert({
      draft_id: draftId,
      action: "send_cancelled",
      actor_id: actorId,
      before_value: { status },
      after_value: { send_job_id: jobId },
      reason: body.reason ?? null,
      request_ip: ip === "unknown" ? null : ip,
    });
    return NextResponse.json({ ok: true, status: "cancelled" });
  }

  return NextResponse.json(
    { ok: false, reason: "unreachable" },
    { status: 500 }
  );
}
