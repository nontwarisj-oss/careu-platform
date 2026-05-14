// communication_events writer.
//
// One service for all event sources (Twilio status, Resend webhook,
// LINE follow events, our own click/open tracker). Each call
// produces a single row + best-effort dedup via the unique index on
// (provider, provider_event_id).
//
// Server-only.

import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type CommEventType =
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "complained"
  | "unsubscribed"
  | "failed";

export type RecordEventInput = {
  notificationId?: string | null;
  customerId?: string | null;
  branchId?: string | null;
  channel: "sms" | "line" | "email";
  eventType: CommEventType;
  provider?: string | null;
  providerEventId?: string | null;
  targetUrl?: string | null;
  userAgent?: string | null;
  /** Raw IP — hashed before storage to keep PII low. */
  ip?: string | null;
  details?: Record<string, unknown>;
};

const IP_SALT = process.env.SESSION_SECRET ?? "careu-ip-salt-fallback";

function hashIp(ip: string | null | undefined): string | null {
  if (!ip || ip === "unknown") return null;
  return crypto
    .createHmac("sha256", IP_SALT)
    .update(ip)
    .digest("hex")
    .slice(0, 24);
}

export async function recordCommunicationEvent(
  input: RecordEventInput
): Promise<{ ok: boolean; reason?: string; deduped?: boolean }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, reason: "no admin client" };

  const row = {
    notification_id: input.notificationId ?? null,
    customer_id: input.customerId ?? null,
    branch_id: input.branchId ?? null,
    channel: input.channel,
    event_type: input.eventType,
    provider: input.provider ?? null,
    provider_event_id: input.providerEventId ?? null,
    target_url: input.targetUrl ?? null,
    user_agent: input.userAgent ?? null,
    ip_hash: hashIp(input.ip ?? null),
    details: input.details ?? {},
  };

  const res = await admin.from("communication_events").insert(row);
  if (res.error) {
    const msg = res.error.message;
    // Unique-index hit — same provider event already recorded. Treat
    // as success; the dedup index is the primary defence against
    // webhook replay.
    if (
      /duplicate key|communication_events_provider_uniq/i.test(msg ?? "")
    ) {
      return { ok: true, deduped: true };
    }
    return { ok: false, reason: msg };
  }
  return { ok: true };
}

// ---------- Helpers for the dispatch + admin layers --------------------

/**
 * Update a customer_notifications row in response to a provider
 * event. Monotonic transitions only — same logic as the Twilio
 * webhook's STATUS_RANK from Phase 14.
 */
export async function maybeApplyDeliveryStatus(opts: {
  notificationId: string;
  newStatus: "delivered" | "failed";
  errorReason?: string | null;
}): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const patch: Record<string, unknown> = {
    last_provider_status: opts.newStatus,
  };
  if (opts.newStatus === "delivered") {
    patch.status = "delivered";
    patch.delivered_at = new Date().toISOString();
  } else {
    patch.status = "failed";
    if (opts.errorReason) patch.error_reason = opts.errorReason;
  }
  // Only flip if the current status is "earlier" — never downgrade
  // delivered → sent.
  await admin
    .from("customer_notifications")
    .update(patch)
    .eq("id", opts.notificationId)
    .in("status", ["queued", "sending", "sent", "failed"]);
}
