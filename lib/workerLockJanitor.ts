// Worker Lock Janitor — sweeps expired rows out of public.worker_locks.
//
// lib/workerLocks.ts already clears a stale lock opportunistically on
// the next acquire of the SAME name. But a lock whose cron stopped
// running entirely (disabled, renamed, crashed deploy) is never
// re-acquired — its row lingers forever. The janitor is the backstop:
// a periodic sweep that deletes every expired row regardless of name.
//
// It also reports — but does NOT delete — locks that are still within
// their TTL yet suspiciously old (held longer than LONG_HELD_MS). A
// genuinely long tick is fine; a lock held for an hour is a clue the
// holder crashed without releasing and the TTL is too generous.
//
// Server-only. Best-effort — never throws.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

/** A held lock older than this is surfaced for operator attention.
 *  No cron tick should legitimately run this long. */
const LONG_HELD_MS = 60 * 60 * 1000;

export type LockJanitorResult = {
  released: number;
  releasedLocks: Array<{ lock_name: string; expired_for_minutes: number }>;
  longHeld: Array<{ lock_name: string; held_for_minutes: number }>;
  ranAt: string;
};

/**
 * Delete every expired row in worker_locks. Returns a structured
 * summary the cron writes to its heartbeat + the smoke-test reads.
 */
export async function runLockJanitorTick(): Promise<LockJanitorResult> {
  const ranAt = new Date().toISOString();
  const empty: LockJanitorResult = {
    released: 0,
    releasedLocks: [],
    longHeld: [],
    ranAt,
  };
  const admin = getSupabaseAdmin();
  if (!admin) return empty;

  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  try {
    // Snapshot the soon-to-be-deleted rows for the audit detail.
    const expiredRes = await admin
      .from("worker_locks")
      .select("lock_name, expires_at")
      .lt("expires_at", nowIso);
    const expired = (expiredRes.data ?? []) as Array<{
      lock_name: string;
      expires_at: string;
    }>;

    const releasedLocks = expired.map((r) => ({
      lock_name: r.lock_name,
      expired_for_minutes: Math.round(
        (now - new Date(r.expires_at).getTime()) / 60000
      ),
    }));

    if (expired.length > 0) {
      await admin.from("worker_locks").delete().lt("expires_at", nowIso);
    }

    // Locks still alive but suspiciously old.
    const liveRes = await admin
      .from("worker_locks")
      .select("lock_name, acquired_at")
      .gte("expires_at", nowIso);
    const live = (liveRes.data ?? []) as Array<{
      lock_name: string;
      acquired_at: string;
    }>;
    const longHeld = live
      .map((r) => ({
        lock_name: r.lock_name,
        held_for_minutes: Math.round(
          (now - new Date(r.acquired_at).getTime()) / 60000
        ),
      }))
      .filter((r) => r.held_for_minutes * 60000 >= LONG_HELD_MS);

    return {
      released: expired.length,
      releasedLocks,
      longHeld,
      ranAt,
    };
  } catch (err) {
    console.warn(
      "[worker-lock-janitor] sweep failed",
      err instanceof Error ? err.message : String(err)
    );
    return empty;
  }
}
