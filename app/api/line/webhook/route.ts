// POST /api/line/webhook — entry point for LINE Messaging API webhook events.
//
// Responsibilities (all in lib/lineWebhook.ts):
//   1. Read the raw request body bytes (signature verification needs them
//      unmolested — no JSON.parse round-trip before HMAC).
//   2. Verify x-line-signature against LINE_CHANNEL_SECRET.
//   3. Record every event in public.line_follow_events (audit).
//   4. For verified `follow` events: upsert customer_line_links with
//      consented_at=now() and customer_id=NULL.
//   5. For verified `unfollow` events: stamp unsubscribed_at on the
//      existing link row.
//
// LINE expects the webhook to respond 200 fast. We return 200 even on
// signature-failure to avoid the LINE platform disabling our channel from
// repeated 4xx — the rejection is captured in line_follow_events with
// signature_verified=false so admins can spot probe traffic without LINE
// pausing the real webhook.
//
// Required env vars:
//   • LINE_CHANNEL_SECRET — signs the webhook payload.
//   • SUPABASE_SERVICE_ROLE_KEY — needed by the processor for inserts.
//
// LINE Developer Console setup:
//   • Set the webhook URL to https://<deploy>/api/line/webhook
//   • Enable "Use webhook"
//   • Verify the test push from the console works (returns 200).

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  processLineWebhookBody,
  verifyLineSignature,
  type LineWebhookBody,
} from "@/lib/lineWebhook";
import { recordWebhookReceipt } from "@/lib/webhookAudit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  // Raw body bytes — required so the HMAC signature matches.
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature");

  const signatureVerified = verifyLineSignature(rawBody, signature);
  // Phase 25: a stable event id for the audit log — the LINE
  // webhookEventId of the first event, else a hash of the body.
  const eventId = lineEventId(rawBody);

  if (!signatureVerified) {
    await recordWebhookReceipt({
      provider: "line",
      eventId,
      signatureValid: false,
      outcome: "invalid_signature",
    });
  }

  // Parse — accept malformed JSON gracefully (LINE shouldn't send it, but
  // a misconfigured upstream might).
  let parsed: LineWebhookBody;
  try {
    parsed = rawBody.length > 0 ? (JSON.parse(rawBody) as LineWebhookBody) : {};
  } catch {
    await recordWebhookReceipt({
      provider: "line",
      eventId,
      signatureValid: signatureVerified,
      outcome: "malformed",
    });
    // 200 to keep LINE happy even when the body is bad — record nothing.
    return NextResponse.json({
      ok: false,
      reason: "invalid JSON body",
      signatureVerified,
    });
  }

  const result = await processLineWebhookBody(parsed, signatureVerified);

  // Phase 25: audit the verified, processed call.
  if (signatureVerified) {
    await recordWebhookReceipt({
      provider: "line",
      eventId,
      signatureValid: true,
      outcome: "accepted",
      detail: { events: Array.isArray(parsed.events) ? parsed.events.length : 0 },
    });
  }

  // Always 200 — LINE's webhook contract penalises repeated non-2xx by
  // disabling the channel. Unverified / unprocessable events are visible
  // in the response body and in public.line_follow_events for admin
  // postmortem.
  return NextResponse.json(result);
}

/** Derive a stable idempotency key for a LINE webhook delivery. */
function lineEventId(rawBody: string): string {
  try {
    const body = JSON.parse(rawBody) as {
      events?: Array<{ webhookEventId?: string }>;
    };
    const first = body.events?.[0]?.webhookEventId;
    if (first) return first;
  } catch {
    // fall through to body hash
  }
  return crypto.createHash("sha256").update(rawBody).digest("hex").slice(0, 32);
}

// LINE's console "verify" button issues a GET to confirm the URL is alive.
// Return a small JSON ack so the operator gets a clean check.
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "line-webhook",
    method: "GET is alive — LINE sends actual events via POST",
  });
}
