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
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type CronName =
  | "dispatch-worker"
  | "retry-worker"
  | "broadcast-send"
  | "overdue-pickup-sweep"
  | "heic-transcode"
  | "reconcile"
  | "engagement-aggregate"
  | "retention-triggers";

export type HeartbeatPayload = {
  rowsProcessed?: number;
  details?: Record<string, unknown>;
};

export type CronHandler<T> = () => Promise<{
  result: T;
  payload?: HeartbeatPayload;
}>;

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
 *   });
 */
export async function withCronHeartbeat<T>(
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
