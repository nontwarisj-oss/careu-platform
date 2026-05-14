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
  if (!isSignatureValid(rawBody, sig, secret)) {
    return NextResponse.json(
      { ok: false, reason: "invalid signature" },
      { status: 403 }
    );
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(rawBody) as ResendEvent;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "invalid JSON" },
      { status: 400 }
    );
  }

  const internal = event.type ? EVENT_TO_INTERNAL[event.type] ?? null : null;
  if (!internal) {
    // Acknowledge unknown events with 200 — Resend / Svix penalises
    // sustained non-2xx by pausing the webhook.
    return NextResponse.json({ ok: true, handled: false });
  }

  const tags = event.data?.tags ?? [];
  const notificationTag = tags.find((t) => t.name === "notification_id");
  const notificationId = notificationTag?.value ?? null;
  const providerEventId = event.data?.email_id ?? null;

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

  return NextResponse.json({ ok: true, handled: true, mapped: internal });
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "email-status" });
}
