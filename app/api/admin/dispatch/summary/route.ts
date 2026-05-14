// GET /api/admin/dispatch/summary — counts for the /admin/dispatch UI.
//
// Returns queue depth by status + recent failures so the admin can see
// "is the worker alive? is anything piling up?".

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function count(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  status: string
): Promise<number> {
  const { count } = await admin
    .from("customer_notifications")
    .select("id", { count: "exact", head: true })
    .eq("status", status);
  return count ?? 0;
}

export async function GET() {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  const [queued, sending, sent, delivered, failed, deadLetter, skipped, cancelled] =
    await Promise.all([
      count(admin, "queued"),
      count(admin, "sending"),
      count(admin, "sent"),
      count(admin, "delivered"),
      count(admin, "failed"),
      count(admin, "dead_letter"),
      count(admin, "skipped"),
      count(admin, "cancelled"),
    ]);

  // Recent rows for the table view. 25 most-recent failures + 25 most-
  // recent queued so the operator can spot patterns at a glance.
  const failuresRes = await admin
    .from("customer_notifications")
    .select(
      "id, channel, kind, status, attempts, send_after, sent_at, error_reason, customer_id, branch_id, created_at"
    )
    .in("status", ["failed"])
    .order("created_at", { ascending: false })
    .limit(25);
  const queuedRes = await admin
    .from("customer_notifications")
    .select(
      "id, channel, kind, status, attempts, send_after, customer_id, branch_id, created_at"
    )
    .in("status", ["queued", "sending"])
    .order("send_after", { ascending: true })
    .limit(25);

  // Observability — last 24h dispatch log slice. Aggregate in-app to
  // avoid a dependency on a Postgres aggregate view; the log is bounded
  // by retention and the slice is small (typically 100s of rows).
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dispatchLogRes = await admin
    .from("notification_dispatch_log")
    .select("channel, outcome, attempt, latency_ms, created_at")
    .gte("created_at", since24h)
    .limit(1000);
  const obsRows =
    dispatchLogRes.error || !dispatchLogRes.data
      ? []
      : (dispatchLogRes.data as Array<{
          channel: string;
          outcome: string;
          attempt: number;
          latency_ms: number | null;
          created_at: string;
        }>);

  // Resend log slice — feeds the observability resend-trend gauge.
  const resendRes = await admin
    .from("notification_resend_log")
    .select("id, action, created_at, branch_id")
    .gte("created_at", since24h)
    .limit(1000);
  const resendRows =
    resendRes.error || !resendRes.data
      ? []
      : (resendRes.data as Array<{
          id: string;
          action: string;
          created_at: string;
          branch_id: string | null;
        }>);

  // Rate-limit trigger slice — dispatch log skipped rows with bucket
  // info. These tell the operator "our per-customer caps fired N times
  // today" — useful for tuning the caps.
  const rateLimitRes = await admin
    .from("notification_dispatch_log")
    .select("id, channel, details, created_at, reason")
    .eq("outcome", "skipped")
    .gte("created_at", since24h)
    .limit(500);
  const rateLimitRows =
    rateLimitRes.error || !rateLimitRes.data
      ? []
      : (rateLimitRes.data as Array<{
          id: string;
          channel: string;
          details: Record<string, unknown>;
          created_at: string;
          reason: string | null;
        }>);

  const observability = computeObservability(obsRows, resendRows, rateLimitRows);

  // Broadcast health — active send jobs + recent dead-letter trends.
  const sendJobsActive = await admin
    .from("broadcast_send_jobs")
    .select("id, status, channels, expected_total, started_at, scheduled_for, paused_at")
    .in("status", ["queued", "processing", "paused"])
    .order("scheduled_for", { ascending: true, nullsFirst: true })
    .limit(10);
  const sendJobsRecent = await admin
    .from("broadcast_send_jobs")
    .select("id, status, completed_at, cancelled_at, failure_reason")
    .gte("created_at", since24h)
    .order("created_at", { ascending: false })
    .limit(20);

  return NextResponse.json({
    ok: true,
    counts: {
      queued,
      sending,
      sent,
      delivered,
      failed,
      dead_letter: deadLetter,
      skipped,
      cancelled,
    },
    recentFailures: failuresRes.data ?? [],
    pendingPreview: queuedRes.data ?? [],
    smsProvider: (process.env.SMS_PROVIDER ?? "console").toLowerCase(),
    observability,
    broadcastHealth: {
      activeJobs: sendJobsActive.data ?? [],
      recent24h: sendJobsRecent.data ?? [],
    },
  });
}

type DispatchLogSlice = Array<{
  channel: string;
  outcome: string;
  attempt: number;
  latency_ms: number | null;
  created_at: string;
}>;

function computeObservability(
  rows: DispatchLogSlice,
  resendRows: Array<{ id: string; action: string; created_at: string }>,
  rateLimitRows: Array<{
    id: string;
    channel: string;
    details: Record<string, unknown>;
    created_at: string;
    reason: string | null;
  }>
) {
  const total = rows.length;
  const sent = rows.filter((r) => r.outcome === "sent").length;
  const failed = rows.filter((r) => r.outcome === "failed").length;
  const skipped = rows.filter((r) => r.outcome === "skipped").length;

  const successRate = total > 0 ? Math.round((sent / total) * 1000) / 10 : null;

  // Retry depth — average attempt number for failed rows. Higher means
  // the worker is grinding before giving up.
  const failedRows = rows.filter((r) => r.outcome === "failed");
  const avgRetryDepth =
    failedRows.length === 0
      ? 0
      : Math.round(
          (failedRows.reduce((acc, r) => acc + r.attempt, 0) /
            failedRows.length) *
            10
        ) / 10;

  // Provider latency proxy — p50 + p95 over sent rows that have a
  // latency_ms set. Skipped rows skip the provider entirely so they
  // have no latency.
  const latencies = rows
    .filter((r) => r.outcome === "sent" && r.latency_ms != null)
    .map((r) => r.latency_ms as number)
    .sort((a, b) => a - b);

  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);

  // Dead-letter trend — last 24h vs prior 24h. The dispatch log only
  // has the last 24h above; we approximate by sampling failed rows
  // bucketed by hour for a small trend line.
  const trend: Array<{ hour: string; failed: number; sent: number }> = [];
  const now = Date.now();
  for (let i = 23; i >= 0; i--) {
    const bucketStart = now - (i + 1) * 60 * 60 * 1000;
    const bucketEnd = now - i * 60 * 60 * 1000;
    const inBucket = rows.filter((r) => {
      const t = new Date(r.created_at).getTime();
      return t >= bucketStart && t < bucketEnd;
    });
    trend.push({
      hour: new Date(bucketEnd).toISOString().slice(0, 13),
      failed: inBucket.filter((r) => r.outcome === "failed").length,
      sent: inBucket.filter((r) => r.outcome === "sent").length,
    });
  }

  // Per-channel breakdown.
  const byChannel: Record<
    string,
    { sent: number; failed: number; skipped: number; total: number; successRate: number | null }
  > = {};
  rows.forEach((r) => {
    const slot = (byChannel[r.channel] ??= {
      sent: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      successRate: null,
    });
    slot.total += 1;
    if (r.outcome === "sent") slot.sent += 1;
    else if (r.outcome === "failed") slot.failed += 1;
    else if (r.outcome === "skipped") slot.skipped += 1;
  });
  Object.values(byChannel).forEach((slot) => {
    slot.successRate =
      slot.total > 0 ? Math.round((slot.sent / slot.total) * 1000) / 10 : null;
  });

  // Resend totals — operator manual sends + dead-letter retries.
  const resendsByAction: Record<string, number> = {};
  resendRows.forEach((r) => {
    resendsByAction[r.action] = (resendsByAction[r.action] ?? 0) + 1;
  });

  // Rate-limit triggers — count by bucket name so the operator sees
  // which limit is firing.
  const rateLimitByBucket: Record<string, number> = {};
  rateLimitRows.forEach((r) => {
    const bucket =
      typeof r.details?.rateLimitBucket === "string"
        ? (r.details.rateLimitBucket as string)
        : "other";
    rateLimitByBucket[bucket] = (rateLimitByBucket[bucket] ?? 0) + 1;
  });

  return {
    windowHours: 24,
    sampleSize: total,
    sent,
    failed,
    skipped,
    successRate,
    avgRetryDepth,
    providerLatencyMs: { p50, p95, samples: latencies.length },
    deadLetterTrend: trend,
    byChannel,
    resends: {
      total: resendRows.length,
      byAction: resendsByAction,
    },
    rateLimitTriggers: {
      total: rateLimitRows.length,
      byBucket: rateLimitByBucket,
    },
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
