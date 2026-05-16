// Webhook Retry Queue — the platform's own recovery path for a
// provider callback that verified + parsed cleanly but then FAILED
// during processing.
//
// Flow:
//   1. A webhook route's processing throws → enqueueWebhookRetry()
//      captures the normalized DeliveryReceipt.
//   2. The webhook-retry cron calls runWebhookRetryTick() → for each
//      due row, applyDeliveryReceipt() is re-run.
//   3. Success → status='succeeded'. Failure → exponential backoff,
//      attempts++. attempts ≥ max_attempts → status='dead_letter'.
//
// Replay-safe: applyDeliveryReceipt only moves notification state
// forward (Phase 25/26 idempotency). Audit-safe: every transition
// updates the row. Branch-isolated: branch_id flows from the receipt.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  applyDeliveryReceipt,
  type DeliveryReceipt,
} from "@/lib/deliveryReceipt";

const BACKOFF_BASE_MIN = 2;
const BACKOFF_MULTIPLIER = 4;
const MAX_BACKOFF_MIN = 6 * 60;
const DEFAULT_MAX_ATTEMPTS = 6;

function backoffMinutes(attempt: number): number {
  const raw = BACKOFF_BASE_MIN * Math.pow(BACKOFF_MULTIPLIER, attempt);
  return Math.min(raw, MAX_BACKOFF_MIN);
}

/**
 * Capture a failed webhook for retry. Best-effort — if the queue
 * insert itself fails we fall back to the provider's own retry.
 */
export async function enqueueWebhookRetry(opts: {
  receipt: DeliveryReceipt;
  failureReason: string;
}): Promise<{ ok: boolean }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false };
  try {
    await admin.from("webhook_retry_queue").insert({
      provider: opts.receipt.provider,
      event_id: opts.receipt.eventId,
      receipt: opts.receipt as unknown as Record<string, unknown>,
      branch_id: opts.receipt.branchId,
      status: "pending",
      attempts: 0,
      max_attempts: DEFAULT_MAX_ATTEMPTS,
      next_retry_at: new Date(
        Date.now() + backoffMinutes(0) * 60_000
      ).toISOString(),
      last_error: opts.failureReason.slice(0, 500),
    });
    return { ok: true };
  } catch (err) {
    console.warn(
      "[webhook-retry] enqueue failed",
      err instanceof Error ? err.message : String(err)
    );
    return { ok: false };
  }
}

export type RetryTickResult = {
  processed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
};

/** Drain due rows. Called by the webhook-retry cron. */
export async function runWebhookRetryTick(opts?: {
  limit?: number;
}): Promise<RetryTickResult> {
  const result: RetryTickResult = {
    processed: 0,
    succeeded: 0,
    retried: 0,
    deadLettered: 0,
  };
  const admin = getSupabaseAdmin();
  if (!admin) return result;
  const limit = Math.max(1, Math.min(opts?.limit ?? 25, 100));

  const dueRes = await admin
    .from("webhook_retry_queue")
    .select("id, provider, event_id, receipt, attempts, max_attempts")
    .in("status", ["pending", "retrying"])
    .lte("next_retry_at", new Date().toISOString())
    .order("next_retry_at", { ascending: true })
    .limit(limit);
  const rows = (dueRes.data ?? []) as Array<{
    id: string;
    provider: string;
    event_id: string | null;
    receipt: DeliveryReceipt;
    attempts: number;
    max_attempts: number;
  }>;

  for (const row of rows) {
    result.processed += 1;
    const attempt = row.attempts + 1;
    try {
      const applied = await applyDeliveryReceipt(row.receipt);
      if (applied.ok) {
        await admin
          .from("webhook_retry_queue")
          .update({
            status: "succeeded",
            attempts: attempt,
            last_error: null,
          })
          .eq("id", row.id);
        result.succeeded += 1;
        continue;
      }
      throw new Error(applied.reason ?? "applyDeliveryReceipt returned ok=false");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (attempt >= row.max_attempts) {
        await admin
          .from("webhook_retry_queue")
          .update({
            status: "dead_letter",
            attempts: attempt,
            last_error: reason.slice(0, 500),
            terminal_reason: `exhausted ${row.max_attempts} attempts`,
          })
          .eq("id", row.id);
        result.deadLettered += 1;
      } else {
        await admin
          .from("webhook_retry_queue")
          .update({
            status: "retrying",
            attempts: attempt,
            last_error: reason.slice(0, 500),
            next_retry_at: new Date(
              Date.now() + backoffMinutes(attempt) * 60_000
            ).toISOString(),
          })
          .eq("id", row.id);
        result.retried += 1;
      }
    }
  }

  return result;
}

// ---------- Admin helpers -----------------------------------------------

export type WebhookRetryRow = {
  id: string;
  provider: string;
  event_id: string | null;
  receipt: DeliveryReceipt;
  branch_id: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
  last_error: string | null;
  terminal_reason: string | null;
  created_at: string;
  updated_at: string;
};

export async function listWebhookRetries(opts: {
  status?: string;
  provider?: string;
  branchId?: string | null;
  limit?: number;
}): Promise<WebhookRetryRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  let q = admin
    .from("webhook_retry_queue")
    .select(
      "id, provider, event_id, receipt, branch_id, status, attempts, max_attempts, next_retry_at, last_error, terminal_reason, created_at, updated_at"
    )
    .order("updated_at", { ascending: false })
    .limit(Math.min(opts.limit ?? 100, 300));
  if (opts.status) q = q.eq("status", opts.status);
  if (opts.provider) q = q.eq("provider", opts.provider);
  if (opts.branchId) q = q.eq("branch_id", opts.branchId);
  const res = await q;
  if (res.error || !res.data) return [];
  return res.data as WebhookRetryRow[];
}

/**
 * Operator-triggered replay of one queue row — runs immediately,
 * regardless of status (including dead_letter). Idempotent.
 */
export async function replayWebhookRetry(
  id: string,
  actorId: string
): Promise<{ ok: boolean; reason?: string; applied?: string[] }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, reason: "no admin client" };
  const r = await admin
    .from("webhook_retry_queue")
    .select("id, receipt, attempts")
    .eq("id", id)
    .maybeSingle();
  const row = r.data as
    | { id: string; receipt: DeliveryReceipt; attempts: number }
    | null;
  if (!row) return { ok: false, reason: "ไม่พบ row" };

  try {
    const applied = await applyDeliveryReceipt(row.receipt);
    if (!applied.ok) throw new Error(applied.reason ?? "apply failed");
    await admin
      .from("webhook_retry_queue")
      .update({
        status: "succeeded",
        attempts: row.attempts + 1,
        last_error: null,
        resolved_by: actorId,
      })
      .eq("id", id);
    return { ok: true, applied: applied.applied };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await admin
      .from("webhook_retry_queue")
      .update({
        attempts: row.attempts + 1,
        last_error: reason.slice(0, 500),
        resolved_by: actorId,
      })
      .eq("id", id);
    return { ok: false, reason };
  }
}

export type WebhookRetryMetrics = {
  windowHours: number;
  pending: number;
  retrying: number;
  deadLetter: number;
  succeeded24h: number;
};

export async function webhookRetryMetrics(
  windowHours = 24
): Promise<WebhookRetryMetrics> {
  const empty: WebhookRetryMetrics = {
    windowHours,
    pending: 0,
    retrying: 0,
    deadLetter: 0,
    succeeded24h: 0,
  };
  const admin = getSupabaseAdmin();
  if (!admin) return empty;
  const since = new Date(
    Date.now() - windowHours * 60 * 60 * 1000
  ).toISOString();
  const db = admin;
  try {
    const countByStatus = async (status: string, sinceFilter?: string) => {
      let q = db
        .from("webhook_retry_queue")
        .select("id", { count: "exact", head: true })
        .eq("status", status);
      if (sinceFilter) q = q.gte("updated_at", sinceFilter);
      const r = await q;
      return r.count ?? 0;
    };
    const pending = await countByStatus("pending");
    const retrying = await countByStatus("retrying");
    const deadLetter = await countByStatus("dead_letter");
    const succeeded24h = await countByStatus("succeeded", since);
    return { windowHours, pending, retrying, deadLetter, succeeded24h };
  } catch {
    return empty;
  }
}
