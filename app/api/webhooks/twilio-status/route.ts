// POST /api/webhooks/twilio-status — Twilio MessageStatus delivery
// webhook receiver.
//
// Twilio fires this URL on every status transition for an outbound SMS:
//   queued → sent → delivered  (happy path)
//                 → failed | undelivered  (terminal failures)
//
// We map vendor statuses to our internal status enum (queued / sent /
// delivered / failed / dead_letter) and update the matching
// customer_notifications row by provider_message_id (MessageSid).
//
// Security:
//   • Twilio signs each request with X-Twilio-Signature. We verify it
//     using TWILIO_AUTH_TOKEN — without the token a forged callback
//     can't trick us into setting status='delivered' for a row that
//     never sent.
//   • Replay protection: the underlying status is monotonic (queued <
//     sent < delivered/failed). We reject transitions that would
//     downgrade — e.g. delivered → sent is a no-op. Twilio retries
//     idempotently on its own; our idempotency comes from the
//     "monotonic only" rule.
//   • The webhook does NOT trust query params for the SID — only the
//     signed body counts.
//
// Server-only. No auth cookie. The path itself is publicly reachable.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------- Twilio status mapping ----------------------------------------

const TWILIO_TO_INTERNAL: Record<
  string,
  "queued" | "sent" | "delivered" | "failed"
> = {
  // Provider-acknowledged but not yet on the wire.
  queued: "queued",
  accepted: "queued",
  scheduled: "queued",
  // On the wire / awaiting handset ack.
  sending: "sent",
  sent: "sent",
  // Terminal success.
  delivered: "delivered",
  // Terminal failures.
  failed: "failed",
  undelivered: "failed",
};

const TERMINAL = new Set(["delivered", "failed", "undelivered"]);

// Monotonic ordering — we only allow forward transitions. Higher number
// wins. delivered/failed/dead_letter are terminal.
const STATUS_RANK: Record<string, number> = {
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  failed: 4, // same rank as delivered — both terminal
  dead_letter: 4,
  skipped: 4,
  cancelled: 4,
};

// ---------- Twilio signature verification --------------------------------
//
// Algorithm: HMAC-SHA1(authToken, fullUrl + sortedParamConcat)
// then Base64 encode, compare to X-Twilio-Signature.
//
// We accept form-encoded bodies (Twilio default). JSON is also valid
// per Twilio's docs but uses a different signing variant we don't need
// to support today.

function validateTwilioSignature(opts: {
  authToken: string;
  fullUrl: string;
  params: Record<string, string>;
  signature: string;
}): boolean {
  const { authToken, fullUrl, params, signature } = opts;
  if (!authToken || !signature) return false;
  const sortedKeys = Object.keys(params).sort();
  let toSign = fullUrl;
  for (const k of sortedKeys) {
    toSign += k + (params[k] ?? "");
  }
  const computed = crypto
    .createHmac("sha1", authToken)
    .update(toSign, "utf8")
    .digest("base64");
  // Constant-time compare.
  try {
    const a = Buffer.from(computed);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function buildFullUrl(req: Request): string {
  // Twilio signs the exact URL it called — including the host. Behind
  // Vercel / Cloudflare we trust x-forwarded-host / x-forwarded-proto.
  const url = new URL(req.url);
  const fwdProto = req.headers.get("x-forwarded-proto");
  const fwdHost = req.headers.get("x-forwarded-host");
  if (fwdHost) url.host = fwdHost;
  if (fwdProto) url.protocol = `${fwdProto}:`;
  return url.toString();
}

// ---------- Handler ------------------------------------------------------

type ParsedPayload = {
  raw: Record<string, string>;
  messageSid: string;
  messageStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
  to: string | null;
  from: string | null;
};

async function parseBody(req: Request): Promise<ParsedPayload | null> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/x-www-form-urlencoded")) {
    return null;
  }
  const text = await req.text();
  const params = new URLSearchParams(text);
  const raw: Record<string, string> = {};
  for (const [k, v] of params.entries()) raw[k] = v;
  const messageSid = raw.MessageSid || raw.SmsSid || "";
  const messageStatus = (raw.MessageStatus || raw.SmsStatus || "").toLowerCase();
  if (!messageSid || !messageStatus) return null;
  return {
    raw,
    messageSid,
    messageStatus,
    errorCode: raw.ErrorCode || null,
    errorMessage: raw.ErrorMessage || null,
    to: raw.To || null,
    from: raw.From || null,
  };
}

export async function POST(req: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  if (!authToken) {
    // No verification possible — refuse rather than accept untrusted
    // callbacks. Operator sees a 503 in Twilio's webhook logs and knows
    // to set the env.
    return NextResponse.json(
      { ok: false, reason: "TWILIO_AUTH_TOKEN ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  const payload = await parseBody(req);
  if (!payload) {
    return NextResponse.json(
      { ok: false, reason: "expected form-encoded Twilio callback" },
      { status: 400 }
    );
  }

  const signature = req.headers.get("x-twilio-signature") ?? "";
  const ok = validateTwilioSignature({
    authToken,
    fullUrl: buildFullUrl(req),
    params: payload.raw,
    signature,
  });
  if (!ok) {
    return NextResponse.json(
      { ok: false, reason: "invalid Twilio signature" },
      { status: 403 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  const mapped = TWILIO_TO_INTERNAL[payload.messageStatus];
  if (!mapped) {
    // Unknown status — log and 200 so Twilio doesn't retry forever.
    console.warn(
      `[twilio-webhook] unknown MessageStatus=${payload.messageStatus} sid=${payload.messageSid}`
    );
    return NextResponse.json({ ok: true, handled: false, mapped: null });
  }

  // Look up the notification by provider_message_id. The dispatch
  // worker writes this when it gets the SID back from Twilio's API.
  const lookup = await admin
    .from("customer_notifications")
    .select(
      "id, customer_id, branch_id, channel, kind, status, attempts, provider_message_id"
    )
    .eq("provider_message_id", payload.messageSid)
    .maybeSingle();

  if (lookup.error || !lookup.data) {
    // Unknown SID — could be a stale callback for a notification we
    // never sent, or the SID hasn't landed in our DB yet (race with
    // the dispatch worker's update). Log a dispatch_log entry anyway
    // so the operator can grep.
    await admin.from("notification_dispatch_log").insert({
      notification_id: null,
      customer_id: null,
      branch_id: null,
      channel: "sms",
      kind: "twilio_webhook",
      outcome: mapped === "delivered" ? "sent" : mapped === "failed" ? "failed" : "skipped",
      retryable: false,
      attempt: 0,
      provider: "twilio",
      details: { sid: payload.messageSid, status: payload.messageStatus, errorCode: payload.errorCode, errorMessage: payload.errorMessage },
      reason: `unknown SID ${payload.messageSid}`,
    });
    return NextResponse.json({ ok: true, handled: false, reason: "unknown SID" });
  }

  const row = lookup.data as {
    id: string;
    customer_id: string | null;
    branch_id: string | null;
    channel: string;
    kind: string;
    status: string;
    attempts: number;
    provider_message_id: string | null;
  };

  // Idempotency / replay safety: only apply forward transitions. If we
  // already marked the row delivered, a late "sent" callback is a no-op.
  const currentRank = STATUS_RANK[row.status] ?? 0;
  const nextRank = STATUS_RANK[mapped] ?? 0;
  if (nextRank < currentRank) {
    return NextResponse.json({
      ok: true,
      handled: false,
      reason: `downgrade ignored: ${row.status} → ${mapped}`,
    });
  }
  if (mapped === row.status) {
    // Same state — Twilio retrying. Refresh last_provider_status only.
    await admin
      .from("customer_notifications")
      .update({
        last_provider_status: payload.messageStatus,
      })
      .eq("id", row.id);
    return NextResponse.json({ ok: true, handled: true, idempotent: true });
  }

  const patch: Record<string, unknown> = {
    last_provider_status: payload.messageStatus,
  };
  if (mapped === "delivered") {
    patch.status = "delivered";
    patch.delivered_at = new Date().toISOString();
  } else if (mapped === "failed") {
    patch.status = "failed";
    if (payload.errorMessage || payload.errorCode) {
      patch.error_reason = `Twilio ${payload.errorCode ?? ""}: ${payload.errorMessage ?? payload.messageStatus}`;
    }
  } else if (mapped === "sent") {
    if (row.status === "sending" || row.status === "queued") {
      patch.status = "sent";
      patch.sent_at = new Date().toISOString();
    }
  }

  const upd = await admin
    .from("customer_notifications")
    .update(patch)
    .eq("id", row.id);
  if (upd.error) {
    return NextResponse.json(
      { ok: false, reason: upd.error.message },
      { status: 500 }
    );
  }

  // Append dispatch log + activity row so the customer-facing feed
  // shows "delivered" when the provider confirms.
  await admin.from("notification_dispatch_log").insert({
    notification_id: row.id,
    customer_id: row.customer_id,
    branch_id: row.branch_id,
    channel: row.channel,
    kind: row.kind,
    outcome: mapped === "delivered" ? "sent" : mapped === "failed" ? "failed" : "skipped",
    retryable: false,
    attempt: row.attempts,
    provider: "twilio",
    details: {
      sid: payload.messageSid,
      status: payload.messageStatus,
      errorCode: payload.errorCode,
      errorMessage: payload.errorMessage,
    },
    reason:
      payload.errorMessage ?? `Twilio status ${payload.messageStatus}`,
  });

  if (mapped === "delivered" && row.customer_id) {
    try {
      await admin.from("customer_activity").insert({
        customer_id: row.customer_id,
        branch_id: row.branch_id,
        kind: "notification_delivered",
        payload: {
          channel: row.channel,
          notificationKind: row.kind,
          provider: "twilio",
          sid: payload.messageSid,
        },
      });
    } catch {
      // Audit failures must never bounce the webhook.
    }
  }
  if (mapped === "failed" && row.customer_id) {
    try {
      await admin.from("customer_activity").insert({
        customer_id: row.customer_id,
        branch_id: row.branch_id,
        kind: "notification_failed",
        payload: {
          channel: row.channel,
          notificationKind: row.kind,
          provider: "twilio",
          sid: payload.messageSid,
          errorCode: payload.errorCode,
          errorMessage: payload.errorMessage,
        },
      });
    } catch {}
  }

  return NextResponse.json({
    ok: true,
    handled: true,
    notificationId: row.id,
    newStatus: patch.status ?? row.status,
  });
}

// Optional GET — useful for "is the webhook URL alive" checks from
// Twilio's console.
export async function GET() {
  return NextResponse.json({ ok: true, route: "twilio-status" });
}
