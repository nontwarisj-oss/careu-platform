// POST /api/webhooks/email-status — Resend webhook handler.
//
// Resend signs webhook payloads with `svix-signature` (Svix is their
// webhook delivery infrastructure). We verify the HMAC-SHA256
// signature using RESEND_WEBHOOK_SECRET.
//
// Event types handled:
//   email.delivered    → 'delivered'
//   email.opened       → 'opened'
//   email.clicked      → 'clicked'
//   email.bounced      → 'bounced'
//   email.complained   → 'complained'
//   email.failed       → 'failed'
//
// Notification linking: Resend lets us pass custom headers /tags. We
// pass `notification_id` as a tag; on callback we read it off the
// payload and update customer_notifications + communication_events.
//
// Replay safety: provider_event_id = Resend's event id; the unique
// index on communication_events drops re-deliveries.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  recordCommunicationEvent,
  maybeApplyDeliveryStatus,
  type CommEventType,
} from "@/lib/communicationEvents";
import { maybeRecordBroadcastDelivery } from "@/lib/broadcastDeliveryCallback";
import { confirmAlertEmailDelivery } from "@/lib/deliveryConfirmation";
import { isWebhookReplay, recordWebhookReceipt } from "@/lib/webhookAudit";
import { enqueueWebhookRetry } from "@/lib/webhookRetryQueue";
import { normalizeResendReceipt } from "@/lib/deliveryReceipt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EVENT_TO_INTERNAL: Record<string, CommEventType | null> = {
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  // Resend doesn't ship a built-in unsubscribed event; we capture
  // those via /api/track/click on a List-Unsubscribe link.
};

type ResendEvent = {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[];
    from?: string;
    subject?: string;
    tags?: Array<{ name: string; value: string }>;
    click?: { link?: string };
    bounce?: { type?: string };
  };
  created_at?: string;
};

function isSignatureValid(
  rawBody: string,
  header: string | null,
  secret: string
): boolean {
  if (!header) return false;
  // Svix signature format: "v1,<base64>" possibly with multiple
  // entries space-separated.
  const computed = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  const parts = header.split(" ");
  for (const p of parts) {
    const idx = p.indexOf(",");
    if (idx === -1) continue;
    const sig = p.slice(idx + 1);
    if (sig.length === computed.length) {
      try {
        if (
          crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(computed))
        ) {
          return true;
        }
      } catch {
        // continue
      }
    }
  }
  return false;
}

export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? "";
  if (!secret) {
    return NextResponse.json(
      { ok: false, reason: "RESEND_WEBHOOK_SECRET ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  const rawBody = await req.text();
  const sig = req.headers.get("svix-signature");
  // Svix stamps a unique 'svix-id' on every delivery — the canonical
  // idempotency key for replay protection.
  const svixId = req.headers.get("svix-id");
  if (!isSignatureValid(rawBody, sig, secret)) {
    await recordWebhookReceipt({
      provider: "resend",
      eventId: svixId,
      signatureValid: false,
      outcome: "invalid_signature",
    });
    return NextResponse.json(
      { ok: false, reason: "invalid signature" },
      { status: 403 }
    );
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(rawBody) as ResendEvent;
  } catch {
    await recordWebhookReceipt({
      provider: "resend",
      eventId: svixId,
      signatureValid: true,
      outcome: "malformed",
    });
    return NextResponse.json(
      { ok: false, reason: "invalid JSON" },
      { status: 400 }
    );
  }

  // Replay protection — a re-delivered Svix message is acknowledged
  // 200 but not reprocessed.
  if (svixId && (await isWebhookReplay("resend", svixId))) {
    await recordWebhookReceipt({
      provider: "resend",
      eventId: svixId,
      signatureValid: true,
      outcome: "replay",
    });
    return NextResponse.json({ ok: true, handled: false, reason: "replay" });
  }

  const internal = event.type ? EVENT_TO_INTERNAL[event.type] ?? null : null;
  if (!internal) {
    // Acknowledge unknown events with 200 — Resend / Svix penalises
    // sustained non-2xx by pausing the webhook.
    await recordWebhookReceipt({
      provider: "resend",
      eventId: svixId,
      signatureValid: true,
      outcome: "accepted",
      detail: { type: event.type ?? null, handled: false },
    });
    return NextResponse.json({ ok: true, handled: false });
  }

  // Audit the accepted event. The handlers below are idempotent
  // (communication_events unique index + monotonic queue status).
  await recordWebhookReceipt({
    provider: "resend",
    eventId: svixId,
    signatureValid: true,
    outcome: "accepted",
    detail: { type: event.type ?? null, mapped: internal },
  });

  const tags = event.data?.tags ?? [];
  const notificationTag = tags.find((t) => t.name === "notification_id");
  const notificationId = notificationTag?.value ?? null;
  const providerEventId = event.data?.email_id ?? null;

  // Phase 26: processing runs inside a try — a transient failure is
  // captured into webhook_retry_queue rather than dropped.
  try {

  // Try to backfill customer + branch from the linked notification.
  let customerId: string | null = null;
  let branchId: string | null = null;
  const admin = getSupabaseAdmin();
  if (admin && notificationId) {
    const r = await admin
      .from("customer_notifications")
      .select("customer_id, branch_id")
      .eq("id", notificationId)
      .maybeSingle();
    const row = r.data as
      | { customer_id: string | null; branch_id: string | null }
      | null;
    if (row) {
      customerId = row.customer_id;
      branchId = row.branch_id;
    }
  }

  await recordCommunicationEvent({
    notificationId,
    customerId,
    branchId,
    channel: "email",
    eventType: internal,
    provider: "resend",
    providerEventId,
    targetUrl: event.data?.click?.link ?? null,
    details: {
      type: event.type,
      bounce: event.data?.bounce,
      subject: event.data?.subject,
    },
  });

  // Some events also change the queue row's status (delivered /
  // failed). Open/click don't.
  if (internal === "delivered" && notificationId) {
    await maybeApplyDeliveryStatus({
      notificationId,
      newStatus: "delivered",
    });
  }
  if ((internal === "bounced" || internal === "failed") && notificationId) {
    await maybeApplyDeliveryStatus({
      notificationId,
      newStatus: "failed",
      errorReason: `Resend ${event.type}${
        event.data?.bounce?.type ? `: ${event.data.bounce.type}` : ""
      }`,
    });
  }

  // Phase 21: also bump broadcast_metrics_daily + campaign_funnel_metrics
  // when the notification belongs to a broadcast send_job. Best-effort.
  if (notificationId) {
    if (internal === "delivered") {
      await maybeRecordBroadcastDelivery({ notificationId, stage: "delivered" });
    } else if (internal === "bounced" || internal === "failed") {
      await maybeRecordBroadcastDelivery({ notificationId, stage: "failed" });
    } else if (internal === "opened") {
      await maybeRecordBroadcastDelivery({ notificationId, stage: "opened" });
    } else if (internal === "clicked") {
      await maybeRecordBroadcastDelivery({ notificationId, stage: "clicked" });
    }
  }

  // Phase 24: operator-alert email confirmation. An alert email has
  // no notification_id tag — it is matched by the Resend email_id we
  // stored on its alert_deliveries row at send time. Idempotent +
  // a no-op for customer notifications.
  let alertConfirmed = 0;
  if (providerEventId) {
    if (internal === "delivered") {
      alertConfirmed = await confirmAlertEmailDelivery({
        providerMessageId: providerEventId,
        status: "delivered",
      });
    } else if (internal === "bounced" || internal === "failed") {
      alertConfirmed = await confirmAlertEmailDelivery({
        providerMessageId: providerEventId,
        status: "failed",
        reason: `Resend ${event.type ?? internal}`,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    handled: true,
    mapped: internal,
    alertConfirmed,
  });
  } catch (procErr) {
    // Processing failed after signature + replay passed — capture a
    // normalized receipt into the retry queue, 200-ack.
    const reason =
      procErr instanceof Error ? procErr.message : String(procErr);
    const receipt = normalizeResendReceipt({
      type: event.type ?? "",
      emailId: event.data?.email_id ?? null,
      notificationId,
      eventId: svixId,
    });
    if (receipt) {
      await enqueueWebhookRetry({ receipt, failureReason: reason });
    }
    await recordWebhookReceipt({
      provider: "resend",
      eventId: svixId,
      signatureValid: true,
      outcome: "error",
      detail: { reason, queuedForRetry: Boolean(receipt) },
    });
    return NextResponse.json({ ok: true, handled: false, queuedForRetry: true });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "email-status" });
}
