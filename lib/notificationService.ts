// Customer notification queue — single entry point for "deliver this to
// the customer eventually". Foundation phase WRITES to the queue and
// logs; a future worker reads pending rows and dispatches through the
// existing LINE messaging client + (future) email + SMS providers.
//
// Why a queue and not direct send: scheduling (`send_after`), retry,
// dedup, and admin visibility all benefit from a durable buffer. The
// LINE delivery orchestrator (lib/lineDelivery.ts) is the immediate-send
// path that already exists; this service is the durable-async path the
// future broadcast / reminder engine consumes.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type NotificationChannel = "line" | "email" | "in_app" | "sms";

export type NotificationStatus =
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "skipped";

export type EnqueueNotificationInput = {
  customerId?: string | null;
  branchId?: string | null;
  channel: NotificationChannel;
  /** Free-form event identifier — 'order_ready', 'pickup_reminder',
   *  'welcome', 'reactivation', etc. */
  kind: string;
  /** Template input. Keep PII inside payload (not column-level) so
   *  indexes never accumulate sensitive values. */
  payload?: Record<string, unknown>;
  /** Optional delay — useful for "remind in 24h" / "send tomorrow". */
  sendAfter?: Date | string | null;
  actorId?: string | null;
};

export type EnqueueResult =
  | { ok: true; notificationId: string; queuedAt: string }
  | { ok: false; reason: string };

/**
 * Append one row to public.customer_notifications and return its id.
 * Status starts as `queued`; an external worker (future phase) flips it
 * to `sending` → `sent` / `failed` / `skipped`.
 *
 * Best-effort — `kind` is text with no CHECK so a new caller doesn't
 * need a migration. The dispatcher (future) routes on `kind` + `channel`.
 */
export async function enqueueNotification(
  input: EnqueueNotificationInput
): Promise<EnqueueResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      ok: false,
      reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า — notifications ปิดอยู่",
    };
  }
  const sendAfter =
    input.sendAfter == null
      ? new Date().toISOString()
      : typeof input.sendAfter === "string"
      ? input.sendAfter
      : input.sendAfter.toISOString();

  const res = await admin
    .from("customer_notifications")
    .insert({
      customer_id: input.customerId ?? null,
      branch_id: input.branchId ?? null,
      channel: input.channel,
      kind: input.kind,
      payload: input.payload ?? {},
      status: "queued",
      send_after: sendAfter,
      created_by: input.actorId ?? null,
    })
    .select("id, created_at")
    .single();
  if (res.error || !res.data) {
    return { ok: false, reason: res.error?.message ?? "Insert failed" };
  }
  const row = res.data as { id: string; created_at: string };
  console.info(
    `[notification] queued id=${row.id} channel=${input.channel} kind=${input.kind} customer=${input.customerId ?? "anon"}`
  );
  return { ok: true, notificationId: row.id, queuedAt: row.created_at };
}

// ---------- Read helpers (admin-facing) -----------------------------------

export type NotificationRow = {
  id: string;
  customer_id: string | null;
  branch_id: string | null;
  channel: NotificationChannel;
  kind: string;
  status: NotificationStatus;
  send_after: string;
  sent_at: string | null;
  attempts: number;
  error_reason: string | null;
  created_at: string;
};

const COLUMNS =
  "id, customer_id, branch_id, channel, kind, status, send_after, sent_at, attempts, error_reason, created_at";

/**
 * Pending notifications ready to dispatch — caps at limit. Reads via
 * the admin client so the (future) worker route doesn't need a bridge
 * JWT. RLS on the table still applies for client-side admin pages.
 */
export async function fetchPendingNotifications(
  limit = 50
): Promise<NotificationRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const { data, error } = await admin
    .from("customer_notifications")
    .select(COLUMNS)
    .eq("status", "queued")
    .lte("send_after", new Date().toISOString())
    .order("send_after", { ascending: true })
    .limit(Math.min(limit, 200));
  if (error || !data) return [];
  return data as NotificationRow[];
}

/**
 * Mark a notification's outcome. Used by the future dispatcher worker.
 * The status transitions are linear: queued → sending → (sent | failed
 * | skipped). Foundation phase doesn't actually transition — the
 * helper exists so the worker can be wired in one PR later.
 */
export async function markNotificationOutcome(
  notificationId: string,
  outcome: {
    status: NotificationStatus;
    errorReason?: string | null;
    attempts?: number;
  }
): Promise<{ ok: boolean; reason?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" };
  const patch: Record<string, unknown> = {
    status: outcome.status,
  };
  if (outcome.status === "sent") patch.sent_at = new Date().toISOString();
  if (outcome.errorReason !== undefined)
    patch.error_reason = outcome.errorReason;
  if (typeof outcome.attempts === "number") patch.attempts = outcome.attempts;
  const res = await admin
    .from("customer_notifications")
    .update(patch)
    .eq("id", notificationId);
  if (res.error) return { ok: false, reason: res.error.message };
  return { ok: true };
}
