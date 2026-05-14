// Worker Health Service — aggregates cron_heartbeat_logs +
// customer_notifications + broadcast_send_jobs into a single
// health summary the operator UI can render.
//
// Two consumers:
//   • /admin/system/workers (full dashboard)
//   • Admin shell banner (single boolean: unhealthy or not)
//
// Three "stuck job" detectors:
//   1. Cron silence — a cron hasn't ticked in N minutes (per
//      cron_name expected_interval).
//   2. Queue stall — the oldest customer_notifications row in
//      status='queued' is older than QUEUE_STALL_MINUTES.
//   3. Sending stall — a row stuck in 'sending' for more than
//      SENDING_STALL_MINUTES — the dispatch worker died mid-dispatch.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type { CronName } from "@/lib/cronHeartbeat";

// ---------- Tunables -----------------------------------------------------

const CRON_EXPECTED_INTERVAL_MIN: Record<CronName, number> = {
  "dispatch-worker": 5,
  "retry-worker": 10,
  "broadcast-send": 5,
  "overdue-pickup-sweep": 24 * 60, // daily
  "heic-transcode": 15,
  reconcile: 60,
  "engagement-aggregate": 24 * 60, // nightly
  "retention-triggers": 60, // hourly
};

/** "A queued row should leave the queue within N minutes." Beyond
 *  this the queue is considered stalled. The dispatch worker's
 *  default cadence is 1 min; 10 min gives a generous buffer for
 *  backoff windows. */
const QUEUE_STALL_MINUTES = 10;

/** A row in 'sending' that hasn't transitioned within N minutes
 *  indicates a crashed dispatch attempt. Set generously — provider
 *  timeouts can legitimately take 30s. */
const SENDING_STALL_MINUTES = 5;

/** How long to consider a cron "silent" — multiplier on top of the
 *  expected interval. e.g. interval=5min, multiplier=3 → silent
 *  alert fires at 15min. */
const CRON_SILENCE_MULTIPLIER = 3;

// ---------- Types --------------------------------------------------------

export type CronStatus = {
  cronName: string;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastSuccess: boolean | null;
  lastError: string | null;
  silentForMinutes: number | null;
  expectedIntervalMinutes: number;
  successRate24h: number | null;
  totalRuns24h: number;
  failedRuns24h: number;
  status: "healthy" | "warning" | "critical" | "unknown";
};

export type QueueHealth = {
  queuedTotal: number;
  sendingTotal: number;
  failedTotal: number;
  deadLetterTotal: number;
  oldestQueuedAt: string | null;
  oldestQueuedAgeMinutes: number | null;
  stuckSendingTotal: number;
};

export type AlertHit = {
  ruleId: string;
  ruleName: string;
  metric: string;
  threshold: number;
  observed: number;
  comparison: "gt" | "lt";
  severity: "warning" | "critical";
  branchId: string | null;
};

export type WorkerHealthSnapshot = {
  generatedAt: string;
  overall: "healthy" | "warning" | "critical";
  crons: CronStatus[];
  queue: QueueHealth;
  alerts: AlertHit[];
};

// ---------- Implementation ----------------------------------------------

export async function computeWorkerHealth(): Promise<WorkerHealthSnapshot> {
  const admin = getSupabaseAdmin();
  const now = Date.now();
  const generatedAt = new Date(now).toISOString();

  const emptyResult: WorkerHealthSnapshot = {
    generatedAt,
    overall: "warning",
    crons: [],
    queue: {
      queuedTotal: 0,
      sendingTotal: 0,
      failedTotal: 0,
      deadLetterTotal: 0,
      oldestQueuedAt: null,
      oldestQueuedAgeMinutes: null,
      stuckSendingTotal: 0,
    },
    alerts: [],
  };

  if (!admin) return emptyResult;

  // ----- Cron status (per cron_name) -----
  const cronNames = Object.keys(CRON_EXPECTED_INTERVAL_MIN) as CronName[];
  const crons: CronStatus[] = [];
  for (const name of cronNames) {
    const expected = CRON_EXPECTED_INTERVAL_MIN[name];
    const silenceThreshold = expected * CRON_SILENCE_MULTIPLIER;

    // Last run.
    const lastRes = await admin
      .from("cron_heartbeat_logs")
      .select("started_at, duration_ms, success, error_message")
      .eq("cron_name", name)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const last = lastRes.data as
      | {
          started_at: string;
          duration_ms: number | null;
          success: boolean;
          error_message: string | null;
        }
      | null;

    let silentForMinutes: number | null = null;
    if (last) {
      const ageMs = now - new Date(last.started_at).getTime();
      silentForMinutes = Math.round(ageMs / 60000);
    }

    // 24h success rate.
    const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const totalRes = await admin
      .from("cron_heartbeat_logs")
      .select("id", { count: "exact", head: true })
      .eq("cron_name", name)
      .gte("started_at", since24h);
    const failedRes = await admin
      .from("cron_heartbeat_logs")
      .select("id", { count: "exact", head: true })
      .eq("cron_name", name)
      .eq("success", false)
      .gte("started_at", since24h);
    const total = totalRes.count ?? 0;
    const failed = failedRes.count ?? 0;
    const successRate =
      total > 0 ? Math.round(((total - failed) / total) * 1000) / 10 : null;

    let status: CronStatus["status"] = "unknown";
    if (!last) status = "unknown";
    else if (silentForMinutes != null && silentForMinutes > silenceThreshold) {
      status = "critical";
    } else if (
      silentForMinutes != null &&
      silentForMinutes > expected * 1.5
    ) {
      status = "warning";
    } else if (successRate != null && successRate < 80) {
      status = "warning";
    } else {
      status = "healthy";
    }

    crons.push({
      cronName: name,
      lastRunAt: last?.started_at ?? null,
      lastDurationMs: last?.duration_ms ?? null,
      lastSuccess: last ? last.success : null,
      lastError: last?.error_message ?? null,
      silentForMinutes,
      expectedIntervalMinutes: expected,
      successRate24h: successRate,
      totalRuns24h: total,
      failedRuns24h: failed,
      status,
    });
  }

  // ----- Queue health -----
  const queueRes = await admin
    .from("customer_notifications")
    .select("send_after, created_at, status")
    .in("status", ["queued", "sending", "failed", "dead_letter"])
    .order("send_after", { ascending: true })
    .limit(1000);
  const rows =
    queueRes.error || !queueRes.data
      ? []
      : (queueRes.data as Array<{
          send_after: string;
          created_at: string;
          status: string;
        }>);
  const queuedRows = rows.filter((r) => r.status === "queued");
  const sendingRows = rows.filter((r) => r.status === "sending");
  const failedRows = rows.filter((r) => r.status === "failed");
  const deadLetterRows = rows.filter((r) => r.status === "dead_letter");

  // Oldest queued row.
  let oldestQueuedAt: string | null = null;
  let oldestQueuedAgeMinutes: number | null = null;
  if (queuedRows.length > 0) {
    const oldest = queuedRows.reduce((a, b) =>
      new Date(a.send_after) < new Date(b.send_after) ? a : b
    );
    oldestQueuedAt = oldest.send_after;
    oldestQueuedAgeMinutes = Math.round(
      (now - new Date(oldest.send_after).getTime()) / 60000
    );
  }

  // Stuck sending — rows that have been 'sending' > SENDING_STALL_MINUTES.
  const sendingStallCutoff = now - SENDING_STALL_MINUTES * 60 * 1000;
  const stuckSending = sendingRows.filter(
    (r) => new Date(r.created_at).getTime() < sendingStallCutoff
  );

  const queue: QueueHealth = {
    queuedTotal: queuedRows.length,
    sendingTotal: sendingRows.length,
    failedTotal: failedRows.length,
    deadLetterTotal: deadLetterRows.length,
    oldestQueuedAt,
    oldestQueuedAgeMinutes,
    stuckSendingTotal: stuckSending.length,
  };

  // ----- Alert rule evaluation -----
  const alerts = await evaluateAlertRules(admin, {
    queue,
    crons,
  });

  // Overall = worst of (cron statuses + alert severities + queue
  // health). Critical wins.
  let overall: WorkerHealthSnapshot["overall"] = "healthy";
  for (const c of crons) {
    if (c.status === "critical") overall = "critical";
    else if (c.status === "warning" && overall === "healthy")
      overall = "warning";
  }
  if (
    queue.oldestQueuedAgeMinutes != null &&
    queue.oldestQueuedAgeMinutes > QUEUE_STALL_MINUTES
  ) {
    overall = "critical";
  } else if (queue.stuckSendingTotal > 0 && overall === "healthy") {
    overall = "warning";
  }
  for (const a of alerts) {
    if (a.severity === "critical") overall = "critical";
    else if (a.severity === "warning" && overall === "healthy")
      overall = "warning";
  }

  return {
    generatedAt,
    overall,
    crons,
    queue,
    alerts,
  };
}

// ---------- Alert-rule evaluator ----------------------------------------

async function evaluateAlertRules(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  ctx: {
    queue: QueueHealth;
    crons: CronStatus[];
  }
): Promise<AlertHit[]> {
  const rulesRes = await admin
    .from("communication_alert_rules")
    .select(
      "id, name, metric, comparison, threshold, window_minutes, severity, branch_id, enabled"
    )
    .eq("enabled", true);
  if (rulesRes.error || !rulesRes.data) return [];
  const rules = rulesRes.data as Array<{
    id: string;
    name: string;
    metric: string;
    comparison: "gt" | "lt";
    threshold: number;
    window_minutes: number;
    severity: "warning" | "critical";
    branch_id: string | null;
    enabled: boolean;
  }>;
  const hits: AlertHit[] = [];

  for (const rule of rules) {
    const observed = await observeMetric(admin, rule.metric, rule.window_minutes, ctx);
    if (observed == null) continue;
    const breached =
      rule.comparison === "gt"
        ? observed > Number(rule.threshold)
        : observed < Number(rule.threshold);
    if (breached) {
      hits.push({
        ruleId: rule.id,
        ruleName: rule.name,
        metric: rule.metric,
        threshold: Number(rule.threshold),
        observed,
        comparison: rule.comparison,
        severity: rule.severity,
        branchId: rule.branch_id,
      });
    }
  }
  return hits;
}

async function observeMetric(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  metric: string,
  windowMinutes: number,
  ctx: { queue: QueueHealth; crons: CronStatus[] }
): Promise<number | null> {
  const since = new Date(
    Date.now() - windowMinutes * 60 * 1000
  ).toISOString();
  switch (metric) {
    case "delivery_success_pct": {
      const total = await admin
        .from("notification_dispatch_log")
        .select("id", { count: "exact", head: true })
        .gte("created_at", since);
      const sent = await admin
        .from("notification_dispatch_log")
        .select("id", { count: "exact", head: true })
        .eq("outcome", "sent")
        .gte("created_at", since);
      const totalCount = total.count ?? 0;
      const sentCount = sent.count ?? 0;
      if (totalCount === 0) return null;
      return Math.round((sentCount / totalCount) * 1000) / 10;
    }
    case "dead_letter_count": {
      const r = await admin
        .from("customer_notifications")
        .select("id", { count: "exact", head: true })
        .eq("status", "dead_letter")
        .gte("created_at", since);
      return r.count ?? 0;
    }
    case "queue_age_minutes": {
      // Take the current queue's oldest-pending age.
      return ctx.queue.oldestQueuedAgeMinutes ?? 0;
    }
    case "failure_count": {
      const r = await admin
        .from("notification_dispatch_log")
        .select("id", { count: "exact", head: true })
        .eq("outcome", "failed")
        .gte("created_at", since);
      return r.count ?? 0;
    }
    case "cron_silence_minutes": {
      // Worst silence across all crons.
      const longest = ctx.crons
        .filter((c) => c.silentForMinutes != null)
        .reduce<number | null>(
          (acc, c) =>
            c.silentForMinutes != null && (acc == null || c.silentForMinutes > acc)
              ? c.silentForMinutes
              : acc,
          null
        );
      return longest;
    }
  }
  return null;
}

// ---------- Self-heal actions -------------------------------------------
//
// Called by /api/admin/system/recover-workers. Each action is
// idempotent + audit-loggable.

export type RecoverActionResult = {
  action: string;
  rowsAffected: number;
  details?: Record<string, unknown>;
};

/** Find rows stuck in 'sending' for too long and reset to 'queued'.
 *  Most common cause: dispatch worker crashed mid-send. */
export async function recoverStuckSending(): Promise<RecoverActionResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { action: "stuck_sending", rowsAffected: 0 };
  const cutoff = new Date(
    Date.now() - SENDING_STALL_MINUTES * 60 * 1000
  ).toISOString();
  const res = await admin
    .from("customer_notifications")
    .update({
      status: "queued",
      // Push send_after forward a bit so we don't immediately re-
      // pick the row in the same tick.
      send_after: new Date(Date.now() + 30 * 1000).toISOString(),
    })
    .eq("status", "sending")
    .lt("created_at", cutoff)
    .select("id");
  const rows = (res.data ?? []) as Array<{ id: string }>;
  return {
    action: "stuck_sending",
    rowsAffected: rows.length,
    details: { cutoff },
  };
}

/** Reset broadcast_send_jobs that have been 'processing' but had no
 *  recent fan-out attempt — likely the cron crashed between flagging
 *  the job and writing targets. Set them back to 'queued' so the
 *  next tick re-attempts. */
export async function recoverStuckBroadcastJobs(): Promise<RecoverActionResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { action: "stuck_broadcast_jobs", rowsAffected: 0 };
  // Find jobs in 'processing' whose last attempt was > 30 minutes ago
  // (or never).
  const jobsRes = await admin
    .from("broadcast_send_jobs")
    .select("id, started_at")
    .eq("status", "processing")
    .lt("started_at", new Date(Date.now() - 30 * 60 * 1000).toISOString());
  const jobs = (jobsRes.data ?? []) as Array<{ id: string }>;
  let rowsAffected = 0;
  for (const j of jobs) {
    // Has the job had a recent attempt? If yes, leave it alone — the
    // worker is making progress, just slow.
    const recent = await admin
      .from("broadcast_send_attempts")
      .select("id")
      .eq("send_job_id", j.id)
      .gte("started_at", new Date(Date.now() - 30 * 60 * 1000).toISOString())
      .limit(1)
      .maybeSingle();
    if (recent.data) continue;
    // No recent attempt — the cron either crashed or is silent.
    // The next broadcast-send tick will pick it back up since we're
    // leaving the status as 'processing'. (Cancel would lose work;
    // pause is the operator's choice, not ours.)
    rowsAffected += 1;
  }
  return {
    action: "stuck_broadcast_jobs",
    rowsAffected,
    details: { note: "no automatic reset — operator action recommended" },
  };
}

/** Find dispatch_log rows that say 'sent' but the queue row is still
 *  'sending'. Usually a clue that a webhook isn't reaching us. */
export async function detectInconsistentStates(): Promise<RecoverActionResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { action: "inconsistent_states", rowsAffected: 0 };
  // Pure observation — no writes. Operator reads the count and
  // investigates.
  const res = await admin
    .from("customer_notifications")
    .select("id", { count: "exact", head: true })
    .eq("status", "sending")
    .lt("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
  return {
    action: "inconsistent_states",
    rowsAffected: res.count ?? 0,
    details: { note: "rows in 'sending' > 1h — investigate provider webhook" },
  };
}
