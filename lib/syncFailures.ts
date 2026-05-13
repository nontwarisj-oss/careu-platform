// Structured logger for sync failures. Today this is the "queue" — every
// call lands as a single console.error line with a parseable JSON payload
// so Vercel function logs are searchable + a future cron retry can pick
// failed rows out of the log stream and retry them.
//
// Next-phase upgrade path: replace the console.error with an insert into
// public.sync_failures (TBD) and add a scheduled job that re-runs them.
// Keeping the API stable now means the route handlers won't need to
// change when that happens.
//
// Server-only — never import from a "use client" file.

export type SyncFailureKind =
  | "order_to_sheet"
  | "pricing_to_sheet"
  | "debug_to_sheet"
  | "customer_from_sheet"
  | "expense_from_sheet";

export type SyncFailure = {
  kind: SyncFailureKind;
  /** Stable identifier for the failed unit of work (orderId, snapshotId, …). */
  targetId?: string | null;
  /** Free-form context — surfaces in logs so future retry has everything it needs. */
  payload?: Record<string, unknown>;
  /** Error reason. Strings only — never include raw exception objects. */
  reason: string;
  /** ISO 8601 timestamp; defaults to now() when omitted. */
  failedAt?: string;
};

/**
 * Record a sync failure. Today: structured console.error.
 * Tomorrow: enqueue to public.sync_failures + retry via a cron job.
 *
 * Callers should NEVER throw on the back of this — it is best-effort
 * telemetry, not a guarantee.
 */
export function logSyncFailure(failure: SyncFailure): void {
  const payload = {
    kind: failure.kind,
    targetId: failure.targetId ?? null,
    reason: failure.reason,
    failedAt: failure.failedAt ?? new Date().toISOString(),
    payload: failure.payload ?? {},
  };
  // Single line, JSON-parseable — easy to grep in Vercel function logs.
  console.error(`[sync-failure] ${JSON.stringify(payload)}`);
}
