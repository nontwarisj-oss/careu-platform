// Cron Manifest — the declarative source of truth for every
// scheduled job on the platform.
//
// One entry per cron. The manifest drives:
//   • vercel.json (the `crons` array is generated to match — keep
//     the two in sync; CI could assert this in a later phase).
//   • the /admin/system/workers dashboard "next expected run" +
//     schedule columns.
//   • lib/workerHealth's silence calibration (interval minutes).
//
// Adding a cron = add an entry here, add the route under
// app/api/cron/<name>, and add the matching line to vercel.json.
//
// Server-and-client safe — pure data + pure functions, no imports.

export type CronManifestEntry = {
  /** Stable cron name — must match the CronName passed to
   *  withCronHeartbeat and the cron_heartbeat_logs.cron_name value. */
  cronName: string;
  /** Route path Vercel's scheduler (or any external scheduler) hits. */
  path: string;
  /** Standard 5-field cron expression (UTC on Vercel). */
  schedule: string;
  /** Expected gap between runs, in minutes — silence calibration. */
  intervalMinutes: number;
  /** What the cron does, one line. */
  description: string;
};

export const CRON_MANIFEST: CronManifestEntry[] = [
  {
    cronName: "dispatch-worker",
    path: "/api/cron/dispatch-worker",
    schedule: "*/5 * * * *",
    intervalMinutes: 5,
    description: "Drains the customer_notifications queue (SMS/LINE/email).",
  },
  {
    cronName: "retry-worker",
    path: "/api/cron/retry-worker",
    schedule: "*/10 * * * *",
    intervalMinutes: 10,
    description: "Re-attempts failed sync_failures rows with backoff.",
  },
  {
    cronName: "broadcast-send",
    path: "/api/cron/broadcast-send",
    schedule: "*/5 * * * *",
    intervalMinutes: 5,
    description: "Fans out broadcast_send_jobs into the dispatch queue.",
  },
  {
    cronName: "retention-triggers",
    path: "/api/cron/retention-triggers",
    schedule: "0 * * * *",
    intervalMinutes: 60,
    description: "Hourly retention-trigger sweep (dormant / at-risk / VIP).",
  },
  {
    cronName: "overdue-pickup-sweep",
    path: "/api/cron/overdue-pickup-sweep",
    schedule: "0 6 * * *",
    intervalMinutes: 24 * 60,
    description: "Daily sweep for orders overdue for pickup.",
  },
  {
    cronName: "heic-transcode",
    path: "/api/cron/heic-transcode",
    schedule: "*/15 * * * *",
    intervalMinutes: 15,
    description: "Transcodes pending HEIC uploads to web-friendly JPEG.",
  },
  {
    cronName: "engagement-aggregate",
    path: "/api/cron/engagement-aggregate",
    schedule: "0 1 * * *",
    intervalMinutes: 24 * 60,
    description: "Nightly lifecycle + retention-score recomputation.",
  },
  {
    cronName: "comm-performance-aggregate",
    path: "/api/cron/comm-performance-aggregate",
    schedule: "0 2 * * *",
    intervalMinutes: 24 * 60,
    description: "Nightly per-branch per-channel delivery rollup.",
  },
  {
    cronName: "worker-maintenance",
    path: "/api/cron/worker-maintenance",
    schedule: "*/15 * * * *",
    intervalMinutes: 15,
    description:
      "Lock janitor (stale worker_locks) + alert-rule sweep + escalation.",
  },
  {
    cronName: "operator-digest",
    path: "/api/cron/operator-digest",
    schedule: "0 1 * * 1",
    intervalMinutes: 7 * 24 * 60,
    description: "Weekly operator digest email (Monday 08:00 Bangkok).",
  },
  {
    cronName: "webhook-retry",
    path: "/api/cron/webhook-retry",
    schedule: "*/10 * * * *",
    intervalMinutes: 10,
    description:
      "Re-applies failed provider webhooks from webhook_retry_queue.",
  },
];

/** Look up a manifest entry by cron name. */
export function cronEntry(cronName: string): CronManifestEntry | null {
  return CRON_MANIFEST.find((c) => c.cronName === cronName) ?? null;
}

/**
 * Predict the next expected run from the last run + interval.
 * Returns null when the cron has never run.
 */
export function nextExpectedRun(
  lastRunIso: string | null,
  intervalMinutes: number
): string | null {
  if (!lastRunIso) return null;
  const last = new Date(lastRunIso).getTime();
  if (!Number.isFinite(last)) return null;
  return new Date(last + intervalMinutes * 60_000).toISOString();
}

/**
 * Is the cron overdue for its next run by more than `graceMultiplier`
 * intervals? Used by the dashboard to flag a missed heartbeat.
 */
export function isOverdue(
  lastRunIso: string | null,
  intervalMinutes: number,
  graceMultiplier = 1.5,
  now: number = Date.now()
): boolean {
  if (!lastRunIso) return false;
  const last = new Date(lastRunIso).getTime();
  if (!Number.isFinite(last)) return false;
  return now - last > intervalMinutes * 60_000 * graceMultiplier;
}
