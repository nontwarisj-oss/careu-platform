// Cron Heartbeat — wraps a cron handler so every invocation lands in
// public.cron_heartbeat_logs. The dashboard at /admin/system/workers
// reads from this table to show "last run", "success rate", and the
// "worker silent" alert when a cron stops calling our endpoint.
//
// Contract:
//   • One row per invocation, success or failure.
//   • The wrapper NEVER throws — exceptions inside the handler are
//     caught, logged, and re-thrown so the cron's HTTP response still
//     reflects the error. The DB row records `success=false`.
//   • Heartbeat insert is BEST-EFFORT — if the DB is unreachable we
//     don't fail the cron itself, just lose the telemetry for that
//     tick. The cron's primary job is the actual work, not the log.
//   • Phase 21: each invocation also updates `cron_failure_streaks` so
//     the workers dashboard can surface consecutive-failure counts
//     without scanning the heartbeat log on every render.
//   • Phase 21: an optional `lockName` causes the wrapper to acquire
//     a row in public.worker_locks before running the handler. When
//     another tick holds the lock, the handler is skipped and a
//     heartbeat row is written with success=true + details.skipped=true.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { withWorkerLock } from "@/lib/workerLocks";

export type CronName =
  | "dispatch-worker"
  | "retry-worker"
  | "broadcast-send"
  | "overdue-pickup-sweep"
  | "heic-transcode"
  | "reconcile"
  | "engagement-aggregate"
  | "retention-triggers"
  | "comm-performance-aggregate"
  | "worker-maintenance"
  | "operator-digest"
  | "webhook-retry"
  | "sync-customers";

export type HeartbeatPayload = {
  rowsProcessed?: number;
  details?: Record<string, unknown>;
};

export type CronHandler<T> = () => Promise<{
  result: T;
  payload?: HeartbeatPayload;
}>;

export type CronOptions = {
  /** When set, the wrapper acquires a row in public.worker_locks
   *  before the handler runs. Two concurrent ticks of the same cron
   *  will short-circuit on the second one. */
  lockName?: string;
  /** Lock TTL in ms. Defaults to 5 minutes. Set this longer than the
   *  expected tick duration; the lock auto-expires so a crashed tick
   *  cannot wedge a worker forever. */
  lockTtlMs?: number;
};

/**
 * Run a cron handler with heartbeat instrumentation. The handler
 * returns its result alongside an optional payload that becomes the
 * `rows_processed` + `details` columns on the heartbeat row.
 *
 * Example:
 *
 *   await withCronHeartbeat("dispatch-worker", async () => {
 *     const r = await runDispatchTick(...);
 *     return {
 *       result: r,
 *       payload: { rowsProcessed: r.processed, details: { sent: r.succeeded } },
 *     };
 *   }, { lockName: "cron:dispatch-worker", lockTtlMs: 4 * 60 * 1000 });
 */
export function withCronHeartbeat<T>(
  cronName: CronName,
  handler: CronHandler<T>
): Promise<T>;
export function withCronHeartbeat<T>(
  cronName: CronName,
  handler: CronHandler<T>,
  cronOpts: CronOptions & { lockName: string }
): Promise<T | { skipped: true; reason: string }>;
export async function withCronHeartbeat<T>(
  cronName: CronName,
  handler: CronHandler<T>,
  cronOpts: CronOptions = {}
): Promise<T | { skipped: true; reason: string }> {
  // Concurrency-control path: a sibling tick already holds the lock.
  // We record a "skipped" heartbeat (success=true so the success rate
  // isn't dragged down) and return the sentinel.
  if (cronOpts.lockName) {
    const wrapped = await withWorkerLock(
      cronOpts.lockName,
      () => runWithHeartbeat(cronName, handler),
      { ttlMs: cronOpts.lockTtlMs, acquiredBy: cronName }
    );
    if (wrapped.skipped) {
      const startedAt = new Date();
      await writeHeartbeat({
        cronName,
        startedAt,
        success: true,
        errorMessage: null,
        payload: {
          rowsProcessed: 0,
          details: {
            skipped: true,
            reason: `another ${cronName} tick is holding the lock`,
          },
        },
      });
      // Don't bump or reset failure streak on a skip — it's not a
      // success and it's not a failure; it's a no-op.
      return { skipped: true, reason: wrapped.reason };
    }
    return wrapped.result;
  }
  return runWithHeartbeat(cronName, handler);
}

async function runWithHeartbeat<T>(
  cronName: CronName,
  handler: CronHandler<T>
): Promise<T> {
  const startedAt = new Date();
  let success = true;
  let errorMessage: string | null = null;
  let payload: HeartbeatPayload | undefined;
  let result: T | undefined;
  try {
    const { result: r, payload: p } = await handler();
    result = r;
    payload = p;
  } catch (err) {
    success = false;
    errorMessage = err instanceof Error ? err.message : String(err);
    await writeHeartbeat({
      cronName,
      startedAt,
      success,
      errorMessage,
      payload,
    });
    await updateFailureStreak(cronName, false, errorMessage);
    // Re-throw so the cron's HTTP response reflects the failure.
    throw err;
  }
  await writeHeartbeat({
    cronName,
    startedAt,
    success,
    errorMessage,
    payload,
  });
  await updateFailureStreak(cronName, true, null);
  return result as T;
}

async function writeHeartbeat(opts: {
  cronName: CronName;
  startedAt: Date;
  success: boolean;
  errorMessage: string | null;
  payload?: HeartbeatPayload;
}): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const finishedAt = new Date();
  try {
    await admin.from("cron_heartbeat_logs").insert({
      cron_name: opts.cronName,
      started_at: opts.startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - opts.startedAt.getTime(),
      success: opts.success,
      error_message: opts.errorMessage,
      rows_processed: opts.payload?.rowsProcessed ?? 0,
      details: opts.payload?.details ?? {},
    });
  } catch (err) {
    // Best-effort. A broken cron_heartbeat_logs table must not break
    // the actual cron's work. Log once at warn.
    console.warn(
      "[cron-heartbeat] insert failed",
      err instanceof Error ? err.message : String(err)
    );
  }
}

async function updateFailureStreak(
  cronName: CronName,
  success: boolean,
  errorMessage: string | null
): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const nowIso = new Date().toISOString();
  try {
    if (success) {
      // Reset the streak on every successful tick.
      await admin.from("cron_failure_streaks").upsert(
        {
          cron_name: cronName,
          current_streak: 0,
          last_success_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: "cron_name" }
      );
      return;
    }
    // Failure path: read current streak, increment, write back. The
    // tiny race window between read + write is harmless — at worst
    // the displayed streak under-counts by one for a few seconds.
    const cur = await admin
      .from("cron_failure_streaks")
      .select("current_streak")
      .eq("cron_name", cronName)
      .maybeSingle();
    const prev = (cur.data as { current_streak: number } | null)?.current_streak ?? 0;
    await admin.from("cron_failure_streaks").upsert(
      {
        cron_name: cronName,
        current_streak: prev + 1,
        last_failure_at: nowIso,
        last_failure_message: errorMessage,
        updated_at: nowIso,
      },
      { onConflict: "cron_name" }
    );
  } catch (err) {
    console.warn(
      "[cron-heartbeat] streak update failed",
      err instanceof Error ? err.message : String(err)
    );
  }
}
