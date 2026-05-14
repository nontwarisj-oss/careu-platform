// Structured logger for sync failures. Today's API stays synchronous for
// caller convenience (no await needed in fire-and-forget paths). Two
// destinations:
//   1. console.error  — always. Greppable in Vercel function logs.
//   2. public.sync_failures — best-effort fire-and-forget insert via the
//      service-role admin client when configured. Becomes the queue a
//      future cron job retries from.
//
// Both are best-effort: a DB outage MUST NOT crash the route handler that
// reported the failure.
//
// Server-only — never import from a "use client" file.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type SyncFailureKind =
  | "order_to_sheet"
  | "pricing_to_sheet"
  | "debug_to_sheet"
  | "customer_from_sheet"
  | "expense_from_sheet"
  | "line_send"
  | "receipt_rebuild"
  /** Order is in the DB but no Front_Desk Sheet row matches. Auto-retried
   *  via syncOrderToSheetCore — dedup contract makes the retry safe. */
  | "reconcile_missing_sheet"
  /** Two or more Front_Desk rows share the same Job ID. Manual-only —
   *  requires human judgment about which row stays. */
  | "reconcile_duplicate_sheet"
  /** customer_line_links row has been unlinked for too long. Manual-only —
   *  admin pairs in the linker UI. */
  | "reconcile_orphan_link";

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
  /** Optional branch_code (text slug) so admins can filter by branch. */
  branchId?: string | null;
};

/**
 * Record a sync failure. Returns void (sync from the caller's perspective).
 * The DB persistence runs as fire-and-forget so the route handler doesn't
 * block on it. Errors during persistence are themselves logged but never
 * thrown — the caller has already done its job by signalling the failure.
 */
export function logSyncFailure(failure: SyncFailure): void {
  const payload = {
    kind: failure.kind,
    targetId: failure.targetId ?? null,
    branchId: failure.branchId ?? null,
    reason: failure.reason,
    failedAt: failure.failedAt ?? new Date().toISOString(),
    payload: failure.payload ?? {},
  };
  // 1. Greppable structured log line — always.
  console.error(`[sync-failure] ${JSON.stringify(payload)}`);

  // 2. Best-effort persistence to public.sync_failures.
  void persistSyncFailure(failure);
}

async function persistSyncFailure(failure: SyncFailure): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  try {
    const res = await admin.from("sync_failures").insert({
      kind: failure.kind,
      target_id: failure.targetId ?? null,
      payload: failure.payload ?? {},
      reason: failure.reason,
      branch_id: failure.branchId ?? null,
      status: "pending",
      attempts: 0,
    });
    if (
      res.error &&
      !/relation .* does not exist|schema cache|column .* does not exist/i.test(
        res.error.message
      )
    ) {
      console.warn("[sync-failure] persistence failed", res.error.message);
    }
  } catch (err) {
    console.warn(
      "[sync-failure] persistence threw",
      err instanceof Error ? err.message : String(err)
    );
  }
}
