// Communication Policy Service — the single gate every outbound
// customer message must pass before it gets queued or dispatched.
//
// Today there are three call-paths that decide "can we send this to
// this customer right now?":
//
//   1. lib/lifecycleNotifier.ts — checks prefs + dedup at enqueue
//      time.
//   2. lib/customerRateLimit.ts — checks per-customer caps inside
//      the dispatch worker before each send.
//   3. lib/lineDelivery.ts (legacy) — checks customer_line_links
//      consent + unsubscribe.
//
// Each grew its own opinion. This service unifies the rules into ONE
// function (`evaluatePolicy`) that the notifier / worker / future
// broadcast send code all call. The original modules continue to
// run their inline checks for backwards compatibility — we DON'T
// rip out the existing logic. Instead this service is the new
// authoritative reference; over time the inline checks reduce to
// thin wrappers.
//
// Phase 15 contract: this service composes the existing rate-limit
// + preference logic without replacing it. Adding new rules (e.g.
// "no marketing between 22:00 and 08:00 Bangkok time") only needs
// to land here, not in three places.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  checkPerCustomerRateLimits,
  type RateLimitDecision,
} from "@/lib/customerRateLimit";
import {
  preferenceFieldFor,
  type NotificationKind,
} from "@/lib/notificationTemplates";

// ---------- Types --------------------------------------------------------

export type PolicyChannel = "sms" | "line" | "email" | "in_app";

export type PolicyIntent =
  /** Lifecycle / transactional — order status, payment, OTP. */
  | "transactional"
  /** Marketing / broadcast — opt-in required at customer level. */
  | "promotional";

export type PolicyContext = {
  customerId: string;
  channel: PolicyChannel;
  kind: NotificationKind | string;
  intent: PolicyIntent;
  /** Optional — used by per-order rate-limit bucket. */
  orderId?: string | null;
  /** Operator who triggered the send (manual lifecycle resends).
   *  When set, the policy slightly loosens the dedup constraints
   *  but never the rate-limit / opt-in constraints. */
  actorId?: string | null;
  /** Caller's already-loaded preferences row, if any. Skips the DB
   *  round-trip when the caller already loaded prefs. */
  prefs?: PrefsRow | null;
  /** Caller's already-loaded LINE link presence, if any. */
  lineLinked?: boolean;
  /** When the caller has already loaded the customer phone, supply
   *  it here to skip another DB round-trip. */
  hasPhone?: boolean;
};

export type PolicyDecision =
  | { ok: true }
  | {
      ok: false;
      /** Stable identifier the dispatch_log / dispatch UI can group
       *  on. Examples: 'channel_disabled', 'kind_opted_out',
       *  'rate_limit_<bucket>', 'no_recipient', 'unsubscribed_line'. */
      bucket: string;
      /** Human-readable reason — Thai for customer-visible audit
       *  rows; English for internal logs. */
      reason: string;
    };

type PrefsRow = {
  sms_enabled: boolean;
  line_enabled: boolean;
  email_enabled: boolean;
  pickup_reminders: boolean;
  order_status_alerts: boolean;
  payment_alerts: boolean;
  promotional: boolean;
};

const DEFAULT_PREFS: PrefsRow = {
  sms_enabled: true,
  line_enabled: true,
  email_enabled: false,
  pickup_reminders: true,
  order_status_alerts: true,
  payment_alerts: true,
  promotional: false,
};

// ---------- Helpers ------------------------------------------------------

async function loadPrefs(customerId: string): Promise<PrefsRow> {
  const admin = getSupabaseAdmin();
  if (!admin) return DEFAULT_PREFS;
  const { data } = await admin
    .from("customer_notification_preferences")
    .select(
      "sms_enabled, line_enabled, email_enabled, pickup_reminders, order_status_alerts, payment_alerts, promotional"
    )
    .eq("customer_id", customerId)
    .maybeSingle();
  return (data as PrefsRow | null) ?? DEFAULT_PREFS;
}

async function isLineLinked(customerId: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;
  const { data } = await admin
    .from("customer_line_links")
    .select("line_user_id, unsubscribed_at")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return false;
  const row = data as { unsubscribed_at: string | null };
  return !row.unsubscribed_at;
}

async function customerHasPhone(customerId: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;
  const { data } = await admin
    .from("customers")
    .select("normalized_phone, phone")
    .eq("id", customerId)
    .maybeSingle();
  if (!data) return false;
  const row = data as { normalized_phone: string | null; phone: string | null };
  return !!(row.normalized_phone || row.phone);
}

function channelEnabled(prefs: PrefsRow, channel: PolicyChannel): boolean {
  if (channel === "sms") return prefs.sms_enabled;
  if (channel === "line") return prefs.line_enabled;
  if (channel === "email") return prefs.email_enabled;
  if (channel === "in_app") return true;
  return false;
}

function kindGateField(
  kind: string
): keyof PrefsRow | "transactional" | "promotional" {
  // Try the existing typed mapping first.
  try {
    return preferenceFieldFor(kind as NotificationKind);
  } catch {
    // Unknown kind — default to promotional opt-in. Safe default.
    return "promotional";
  }
}

function kindAllowed(
  prefs: PrefsRow,
  kind: string,
  intent: PolicyIntent
): boolean {
  // OTP / identity-critical bypasses everything below.
  if (intent === "transactional" && kind === "otp") return true;

  const field = kindGateField(kind);
  if (field === "transactional") return true;
  if (field === "promotional") {
    return prefs.promotional === true;
  }
  // Specific kind toggles for the named buckets.
  if (field === "pickup_reminders") return prefs.pickup_reminders;
  if (field === "order_status_alerts") return prefs.order_status_alerts;
  if (field === "payment_alerts") return prefs.payment_alerts;
  return false;
}

// ---------- Public entry -------------------------------------------------

/**
 * Apply the full policy. Order of checks (cheapest first):
 *
 *   1. Channel-master toggle — "did the customer turn this channel off?"
 *   2. Kind toggle — "did the customer opt out of pickup reminders?"
 *   3. Recipient presence — "do we have a phone / LINE link?"
 *   4. Rate limit — "have we sent too many recently?"
 *
 * Returns the FIRST failing reason so the call site can log a clean
 * single-bucket "why didn't this send" message.
 */
export async function evaluatePolicy(
  ctx: PolicyContext
): Promise<PolicyDecision> {
  // 1. Preferences (channel master + kind toggle).
  const prefs = ctx.prefs ?? (await loadPrefs(ctx.customerId));

  if (!channelEnabled(prefs, ctx.channel)) {
    return {
      ok: false,
      bucket: "channel_disabled",
      reason: `ลูกค้าปิดช่อง ${ctx.channel.toUpperCase()} ในการตั้งค่า`,
    };
  }
  if (!kindAllowed(prefs, ctx.kind, ctx.intent)) {
    return {
      ok: false,
      bucket: "kind_opted_out",
      reason: `ลูกค้าไม่ได้อนุญาตข้อความประเภท ${ctx.kind}`,
    };
  }

  // 2. Recipient presence.
  if (ctx.channel === "sms") {
    const has =
      typeof ctx.hasPhone === "boolean"
        ? ctx.hasPhone
        : await customerHasPhone(ctx.customerId);
    if (!has) {
      return {
        ok: false,
        bucket: "no_recipient",
        reason: "ลูกค้าไม่มีเบอร์โทรที่บันทึก",
      };
    }
  }
  if (ctx.channel === "line") {
    const linked =
      typeof ctx.lineLinked === "boolean"
        ? ctx.lineLinked
        : await isLineLinked(ctx.customerId);
    if (!linked) {
      return {
        ok: false,
        bucket: "unsubscribed_line",
        reason: "ลูกค้ายังไม่ได้เพิ่ม LINE OA หรือยกเลิกการติดตาม",
      };
    }
  }
  if (ctx.channel === "email") {
    // No email dispatcher yet — but we still respect the opt-in toggle.
    // Returning ok=true here lets the queue accept the row; the
    // dispatcher's `dispatchManualOnly` is what flags it skipped.
    return { ok: true };
  }
  if (ctx.channel === "in_app") {
    return { ok: true };
  }

  // 3. Rate limit — defer to the existing per-customer module.
  const rl: RateLimitDecision = await checkPerCustomerRateLimits({
    customerId: ctx.customerId,
    channel: ctx.channel,
    kind: ctx.kind,
    orderId: ctx.orderId ?? null,
  });
  if (!rl.ok) {
    return {
      ok: false,
      bucket: `rate_limit_${rl.bucket}`,
      reason: rl.reason,
    };
  }

  return { ok: true };
}
