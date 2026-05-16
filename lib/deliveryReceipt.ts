// Delivery Receipt — the provider-agnostic shape every inbound
// delivery callback normalizes to, plus the single idempotent
// applier that turns one into DB state.
//
// Why this exists:
//   • Phase 25 webhooks each did their own provider-specific
//     processing inline. Phase 26 adds a webhook RETRY QUEUE — and a
//     queued retry must be re-appliable without re-parsing a raw
//     provider payload. A normalized DeliveryReceipt is what gets
//     queued + replayed.
//   • It is also the "future-safe delivery ingestion" layer: when
//     LINE eventually ships delivery receipts, only normalizeLine()
//     needs filling in — applyDeliveryReceipt() already handles it.
//
// applyDeliveryReceipt() is built ENTIRELY from existing idempotent
// helpers (maybeApplyDeliveryStatus / recordCommunicationEvent /
// maybeRecordBroadcastDelivery / confirmAlertEmailDelivery), so a
// replay only ever moves state forward — never double-counts.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  maybeApplyDeliveryStatus,
  recordCommunicationEvent,
  type CommEventType,
} from "@/lib/communicationEvents";
import { maybeRecordBroadcastDelivery } from "@/lib/broadcastDeliveryCallback";
import { confirmAlertEmailDelivery } from "@/lib/deliveryConfirmation";

export type ReceiptProvider = "twilio" | "resend" | "line";

/** Normalized delivery outcome — the union every provider maps onto. */
export type ReceiptStatus =
  | "delivered"
  | "failed"
  | "bounced"
  | "opened"
  | "clicked";

export type DeliveryReceipt = {
  provider: ReceiptProvider;
  /** Provider message id (Twilio SID / Resend email_id). */
  providerMessageId: string | null;
  /** customer_notifications.id when known up-front (Resend tag). */
  notificationId: string | null;
  status: ReceiptStatus;
  channel: "sms" | "line" | "email";
  /** Provider idempotency key — webhook_audit_log.event_id. */
  eventId: string | null;
  branchId: string | null;
  /** When the provider says the event happened. */
  occurredAt: string;
  /** Free-form provider context for the audit trail. */
  raw: Record<string, unknown>;
};

// ---------- Normalizers --------------------------------------------------

const TWILIO_STATUS: Record<string, ReceiptStatus | null> = {
  delivered: "delivered",
  sent: null, // 'sent' is provider-accepted, not a delivery confirmation
  failed: "failed",
  undelivered: "failed",
};

export function normalizeTwilioReceipt(input: {
  messageSid: string;
  messageStatus: string;
  errorMessage?: string | null;
  branchId?: string | null;
}): DeliveryReceipt | null {
  const status = TWILIO_STATUS[input.messageStatus.toLowerCase()] ?? null;
  if (!status) return null;
  return {
    provider: "twilio",
    providerMessageId: input.messageSid,
    notificationId: null,
    status,
    channel: "sms",
    eventId: `${input.messageSid}:${input.messageStatus}`,
    branchId: input.branchId ?? null,
    occurredAt: new Date().toISOString(),
    raw: {
      messageStatus: input.messageStatus,
      errorMessage: input.errorMessage ?? null,
    },
  };
}

const RESEND_STATUS: Record<string, ReceiptStatus | null> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.failed": "failed",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.complained": "bounced",
};

export function normalizeResendReceipt(input: {
  type: string;
  emailId: string | null;
  notificationId: string | null;
  eventId: string | null;
  branchId?: string | null;
}): DeliveryReceipt | null {
  const status = RESEND_STATUS[input.type] ?? null;
  if (!status) return null;
  return {
    provider: "resend",
    providerMessageId: input.emailId,
    notificationId: input.notificationId,
    status,
    channel: "email",
    eventId: input.eventId,
    branchId: input.branchId ?? null,
    occurredAt: new Date().toISOString(),
    raw: { type: input.type },
  };
}

/**
 * LINE delivery-receipt normalizer — PLACEHOLDER. The LINE Messaging
 * API does not currently push per-message delivery receipts; this is
 * the wiring point for when it does. Returns null today.
 */
export function normalizeLineReceipt(
  _input: Record<string, unknown>
): DeliveryReceipt | null {
  return null;
}

// ---------- Applier ------------------------------------------------------

export type ApplyResult = {
  ok: boolean;
  applied: string[];
  reason?: string;
};

const STATUS_TO_STAGE: Record<
  ReceiptStatus,
  "delivered" | "failed" | "opened" | "clicked"
> = {
  delivered: "delivered",
  failed: "failed",
  bounced: "failed",
  opened: "opened",
  clicked: "clicked",
};

const STATUS_TO_EVENT: Record<ReceiptStatus, CommEventType> = {
  delivered: "delivered",
  failed: "failed",
  bounced: "bounced",
  opened: "opened",
  clicked: "clicked",
};

/**
 * Apply a normalized receipt to DB state — idempotently. Throws only
 * on an unexpected failure so the retry queue can catch + re-enqueue;
 * a "notification not found" is a soft no-op, not a throw.
 */
export async function applyDeliveryReceipt(
  receipt: DeliveryReceipt
): Promise<ApplyResult> {
  const applied: string[] = [];
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, applied, reason: "no admin client" };
  }

  // Resolve the notification id when the provider only gave us a
  // message id (Twilio's case).
  let notificationId = receipt.notificationId;
  let branchId = receipt.branchId;
  if (!notificationId && receipt.providerMessageId) {
    const r = await admin
      .from("customer_notifications")
      .select("id, branch_id")
      .eq("provider_message_id", receipt.providerMessageId)
      .maybeSingle();
    const row = r.data as { id: string; branch_id: string | null } | null;
    if (row) {
      notificationId = row.id;
      branchId = branchId ?? row.branch_id;
    }
  }

  // 1. Queue-row status transition (delivered / failed). Monotonic.
  if (
    notificationId &&
    (receipt.status === "delivered" ||
      receipt.status === "failed" ||
      receipt.status === "bounced")
  ) {
    await maybeApplyDeliveryStatus({
      notificationId,
      newStatus: receipt.status === "delivered" ? "delivered" : "failed",
      errorReason:
        receipt.status === "delivered"
          ? undefined
          : `${receipt.provider} ${receipt.status}`,
    });
    applied.push("notification_status");
  }

  // 2. Communication event (dedups on provider_event_id).
  if (notificationId) {
    await recordCommunicationEvent({
      notificationId,
      branchId,
      channel: receipt.channel,
      eventType: STATUS_TO_EVENT[receipt.status],
      provider: receipt.provider,
      providerEventId: receipt.eventId,
      details: { replayed: true, ...receipt.raw },
    });
    applied.push("communication_event");
  }

  // 3. Broadcast metrics + campaign funnel.
  if (notificationId) {
    await maybeRecordBroadcastDelivery({
      notificationId,
      stage: STATUS_TO_STAGE[receipt.status],
    });
    applied.push("broadcast_metric");
  }

  // 4. Operator-alert email confirmation.
  if (
    receipt.provider === "resend" &&
    receipt.providerMessageId &&
    (receipt.status === "delivered" ||
      receipt.status === "failed" ||
      receipt.status === "bounced")
  ) {
    await confirmAlertEmailDelivery({
      providerMessageId: receipt.providerMessageId,
      status: receipt.status === "delivered" ? "delivered" : "failed",
    });
    applied.push("alert_confirm");
  }

  return { ok: true, applied };
}
