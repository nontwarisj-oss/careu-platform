// LINE webhook event processor.
//
// Verifies the x-line-signature header against LINE_CHANNEL_SECRET, then
// records every event in public.line_follow_events for audit. For verified
// `follow` events we ALSO upsert a row into public.customer_line_links
// with customer_id=NULL and consented_at=now() — that becomes the row a
// future admin linker UI fills in once the customer is identified.
//
// The route handler (app/api/line/webhook/route.ts) is intentionally thin;
// all logic lives here so testing and the future per-branch token rollout
// can call the same code paths.
//
// Server-only. Never import from a "use client" file.

import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// ---------- Public types --------------------------------------------------

export type LineWebhookEvent = {
  type: string;
  timestamp?: number;
  source?: {
    type?: string;
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message?: {
    type?: string;
    text?: string;
  };
  replyToken?: string;
};

export type LineWebhookBody = {
  destination?: string;
  events?: LineWebhookEvent[];
};

export type WebhookProcessResult = {
  ok: true;
  signatureVerified: boolean;
  events: number;
  /** Per-event outcome — useful for logs and future admin debugging. */
  items: Array<{
    eventType: string;
    lineUserId: string | null;
    /** True when a public.line_follow_events row was created. */
    audited: boolean;
    /** True when public.customer_line_links was upserted (follow flow). */
    linkUpserted: boolean;
    /** True when public.customer_line_links was marked unsubscribed. */
    unsubscribed: boolean;
    skipped?: string;
  }>;
};

export type WebhookFailureResult = {
  ok: false;
  reason: string;
};

// ---------- Signature verification ----------------------------------------

/**
 * Verify the x-line-signature header against the raw request body using
 * `LINE_CHANNEL_SECRET`. The raw body must be the exact byte sequence LINE
 * signed — DO NOT pass a JSON.parse → JSON.stringify round-trip; whitespace
 * differences will fail the HMAC.
 *
 * Returns false (rather than throwing) when the secret is missing so the
 * route can still record the unverified event for admin inspection.
 */
export function verifyLineSignature(
  rawBody: string,
  signatureHeader: string | null
): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET ?? "";
  if (!secret || !signatureHeader) return false;
  const computed = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  // Constant-time compare to avoid timing attacks on the secret.
  try {
    const a = Buffer.from(computed, "utf8");
    const b = Buffer.from(signatureHeader, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------- Event processing ----------------------------------------------

/**
 * Process a parsed webhook body. Writes audit rows + maintains
 * customer_line_links. Idempotent on repeated follows (upsert by
 * line_user_id) and unfollows (sets unsubscribed_at if a row exists).
 */
export async function processLineWebhookBody(
  body: LineWebhookBody,
  signatureVerified: boolean
): Promise<WebhookProcessResult | WebhookFailureResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      ok: false,
      reason:
        "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า — webhook ทำงานไม่ได้",
    };
  }

  const events = Array.isArray(body.events) ? body.events : [];
  const items: WebhookProcessResult["items"] = [];

  for (const event of events) {
    const lineUserId = event.source?.userId ?? null;
    const incomingType = (event.type ?? "other").toLowerCase();
    const eventType: "follow" | "unfollow" | "message" | "other" =
      incomingType === "follow" ||
      incomingType === "unfollow" ||
      incomingType === "message"
        ? incomingType
        : "other";

    // No user id → record audit row anyway (so admins can spot
    // platform-only events like delivery/postback noise), but skip
    // anything that requires identity.
    const receivedAt = event.timestamp
      ? new Date(event.timestamp).toISOString()
      : new Date().toISOString();
    const consentedAt =
      eventType === "follow" && signatureVerified ? receivedAt : null;

    let audited = false;
    try {
      const auditRes = await admin.from("line_follow_events").insert({
        event_type: eventType,
        line_user_id: lineUserId ?? "",
        raw_event: event as unknown as Record<string, unknown>,
        signature_verified: signatureVerified,
        received_at: receivedAt,
        consented_at: consentedAt,
      });
      audited = !auditRes.error;
      if (auditRes.error) {
        console.warn(
          "[line-webhook] audit insert failed:",
          auditRes.error.message
        );
      }
    } catch (err) {
      console.warn(
        "[line-webhook] audit insert threw:",
        err instanceof Error ? err.message : String(err)
      );
    }

    if (!signatureVerified) {
      // Refuse to touch customer_line_links on unverified traffic so a
      // probe can't pre-create rows or unsubscribe real customers.
      items.push({
        eventType,
        lineUserId,
        audited,
        linkUpserted: false,
        unsubscribed: false,
        skipped: "signature not verified",
      });
      continue;
    }

    if (!lineUserId) {
      items.push({
        eventType,
        lineUserId: null,
        audited,
        linkUpserted: false,
        unsubscribed: false,
        skipped: "no source.userId",
      });
      continue;
    }

    if (eventType === "follow") {
      // Upsert by line_user_id. customer_id stays NULL until an admin
      // pairs this LINE user with a real customer in a future linker UI.
      // The unique index `customer_line_links_line_user_id_uniq` makes
      // this a no-op on duplicate follows.
      const upsert = await admin
        .from("customer_line_links")
        .upsert(
          {
            line_user_id: lineUserId,
            consented_at: receivedAt,
            unsubscribed_at: null,
          },
          { onConflict: "line_user_id" }
        );
      items.push({
        eventType,
        lineUserId,
        audited,
        linkUpserted: !upsert.error,
        unsubscribed: false,
        skipped: upsert.error?.message,
      });
      continue;
    }

    if (eventType === "unfollow") {
      const unsub = await admin
        .from("customer_line_links")
        .update({ unsubscribed_at: receivedAt })
        .eq("line_user_id", lineUserId);
      items.push({
        eventType,
        lineUserId,
        audited,
        linkUpserted: false,
        unsubscribed: !unsub.error,
        skipped: unsub.error?.message,
      });
      continue;
    }

    // message / other — audit only, no state change.
    items.push({
      eventType,
      lineUserId,
      audited,
      linkUpserted: false,
      unsubscribed: false,
    });
  }

  console.info(
    `[line-webhook] processed events=${events.length} verified=${signatureVerified}`
  );

  return {
    ok: true,
    signatureVerified,
    events: events.length,
    items,
  };
}
