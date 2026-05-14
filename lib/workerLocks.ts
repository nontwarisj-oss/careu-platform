// Worker locks — distributed serialization for cron ticks.
//
// Two crons firing the same tick (Vercel's scheduler sometimes retries
// when an invocation looks slow; multiple worker dynos in a future
// deployment; manual operator-triggered ticks) can both pick the same
// row and double-dispatch. This helper acquires a row in
// public.worker_locks before the handler runs and releases it after.
//
// Semantics:
//   • acquireLock(name, ttlMs) — inserts (name, fresh-uuid-nonce,
//     now+ttl) onto the unique primary key. Returns the nonce on
//     success, null when another tick holds the lock.
//   • releaseLock(name, nonce) — deletes the row iff nonce matches.
//     Mismatched nonces leave the row alone (another tick took over
//     after our TTL expired).
//   • Expired locks are cleared opportunistically on acquire.
//
// Best-effort: a missing service-role key means we cannot acquire any
// lock, so the wrapper falls open (returns a sentinel "no-lock" nonce).
// This is intentional — a broken lock layer must not stall the cron.

import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type LockHandle =
  | { acquired: true; nonce: string; releaseRequired: true }
  | { acquired: true; nonce: string; releaseRequired: false }
  | { acquired: false; reason: string };

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export async function acquireLock(
  lockName: string,
  opts: { ttlMs?: number; acquiredBy?: string | null } = {}
): Promise<LockHandle> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { acquired: true, nonce: "no-lock", releaseRequired: false };
  }
  const ttl = Math.max(30_000, opts.ttlMs ?? DEFAULT_TTL_MS);
  const nonce = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = new Date(now + ttl).toISOString();

  // Opportunistically clear expired rows for this name. A separate
  // request is cheaper than racing on the insert.
  try {
    await admin
      .from("worker_locks")
      .delete()
      .eq("lock_name", lockName)
      .lt("expires_at", new Date(now).toISOString());
  } catch {
    // best-effort
  }

  const ins = await admin.from("worker_locks").insert({
    lock_name: lockName,
    nonce,
    expires_at: expiresAt,
    acquired_by: opts.acquiredBy ?? null,
  });
  if (ins.error) {
    return {
      acquired: false,
      reason: ins.error.message,
    };
  }
  return { acquired: true, nonce, releaseRequired: true };
}

export async function releaseLock(
  lockName: string,
  nonce: string
): Promise<void> {
  if (nonce === "no-lock") return;
  const admin = getSupabaseAdmin();
  if (!admin) return;
  try {
    await admin
      .from("worker_locks")
      .delete()
      .eq("lock_name", lockName)
      .eq("nonce", nonce);
  } catch {
    // best-effort
  }
}

/**
 * Run `handler` under a lock named `lockName`. When the lock is held
 * by another tick, returns `skipped: true` without running the handler.
 *
 * This is the only API most callers need.
 */
export async function withWorkerLock<T>(
  lockName: string,
  handler: () => Promise<T>,
  opts: { ttlMs?: number; acquiredBy?: string | null } = {}
): Promise<{ skipped: true; reason: string } | { skipped: false; result: T }> {
  const lock = await acquireLock(lockName, opts);
  if (!lock.acquired) {
    return { skipped: true, reason: lock.reason };
  }
  try {
    const result = await handler();
    return { skipped: false, result };
  } finally {
    if (lock.acquired && lock.releaseRequired) {
      await releaseLock(lockName, lock.nonce);
    }
  }
}
