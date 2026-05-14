// Per-customer / per-channel / per-order rate limit checks for the
// dispatch worker. These are SEPARATE from the IP-based token bucket
// in lib/rateLimit.ts — that one protects the API surface from a
// runaway HTTP client; this one protects the OUTBOUND surface from a
// runaway template / status thrashing / accidental loop.
//
// The motivation is a real production risk: an operator who clicks
// "mark in-progress" and immediately reverts triggers two
// `repair_started` events. The notifier's 6-hour dedup catches that.
// But a bug in a future template that fires on every status flip
// during a 10-minute QC fix-up could send 20 SMS to one customer.
// This module is the second line of defence.
//
// Server-only. Reads customer_notifications + notification_dispatch_log
// to count recent activity.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// ---------- Caps ---------------------------------------------------------

/** Per-channel hourly cap per customer. SMS is tighter than LINE
 *  because each SMS costs real money — LINE pushes are bundled. */
export const PER_CHANNEL_PER_HOUR: Record<"sms" | "line" | "email", number> = {
  sms: 4,
  line: 8,
  email: 4,
};

/** Per-channel daily cap per customer. Daily cap is a soft "spam
 *  guard" — a customer should never see 20 SMS in one day from us. */
export const PER_CHANNEL_PER_DAY: Record<"sms" | "line" | "email", number> = {
  sms: 12,
  line: 30,
  email: 20,
};

/** Across-channel cap per customer per hour. Catches the "status
 *  thrashing" pattern where one event spawns SMS + LINE every minute. */
export const TOTAL_PER_HOUR_PER_CUSTOMER = 10;

/** Across-channel cap per ORDER per day. A single order shouldn't
 *  produce more than this many notifications in a day even across
 *  channels — protects against per-order template loops. */
export const TOTAL_PER_DAY_PER_ORDER = 6;

/** Cooldown between two consecutive notifications of the SAME kind to
 *  the same customer. The notifier's dedup window covers 6h; this is
 *  the within-tick guard for kinds that fire from multiple sources
 *  (e.g. cron + manual button on the same order). */
export const SAME_KIND_COOLDOWN_MINUTES = 30;

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ---------- Types --------------------------------------------------------

export type RateLimitCheckInput = {
  customerId: string;
  channel: "sms" | "line" | "email" | "in_app";
  kind: string;
  orderId?: string | null;
};

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; reason: string; bucket: string };

// ---------- Helpers ------------------------------------------------------

async function countSends(opts: {
  customerId: string;
  channel?: string;
  kind?: string;
  orderId?: string | null;
  sinceMs: number;
}): Promise<number> {
  const admin = getSupabaseAdmin();
  if (!admin) return 0;
  const since = new Date(Date.now() - opts.sinceMs).toISOString();
  // We count "sends in flight or done" — anything that already
  // consumed worker capacity. The dispatch_log captures attempts;
  // counting from customer_notifications gives us intents instead.
  // Intents are the right unit for rate-limiting (a queued + sending
  // intent still occupies the bucket).
  let q = admin
    .from("customer_notifications")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", opts.customerId)
    .in("status", ["queued", "sending", "sent", "delivered"])
    .gte("created_at", since);
  if (opts.channel) q = q.eq("channel", opts.channel);
  if (opts.kind) q = q.eq("kind", opts.kind);
  if (opts.orderId) q = q.eq("payload->>orderId", opts.orderId);
  const res = await q;
  if (res.error) return 0;
  return res.count ?? 0;
}

// ---------- Public entry -------------------------------------------------

/**
 * Decide whether the dispatch worker should proceed with the given
 * notification, given recent activity for the same customer. Called
 * BEFORE dispatching a row but AFTER flagging it as 'sending' — we
 * skip+rollback if the limit fires.
 *
 * Returns ok=true when the row is safe to send. Returns ok=false with
 * a reason + bucket name when a limit fires; the caller marks the row
 * as 'skipped' and continues to the next.
 */
export async function checkPerCustomerRateLimits(
  input: RateLimitCheckInput
): Promise<RateLimitDecision> {
  const channel = input.channel as "sms" | "line" | "email";
  // In-app messages don't go to a real provider — bypass the limit
  // entirely. (in_app rows are operator-rendered, not sent.)
  if (input.channel === "in_app") return { ok: true };

  // 1. Same-kind cooldown — a tighter spam guard for repeat kinds.
  if (input.orderId) {
    const recentSameKind = await countSends({
      customerId: input.customerId,
      channel: input.channel,
      kind: input.kind,
      orderId: input.orderId,
      sinceMs: SAME_KIND_COOLDOWN_MINUTES * 60 * 1000,
    });
    if (recentSameKind > 0) {
      return {
        ok: false,
        bucket: "same_kind_cooldown",
        reason: `same kind+order sent in last ${SAME_KIND_COOLDOWN_MINUTES}m`,
      };
    }
  }

  // 2. Per-channel hourly cap.
  const perChannelHourCap = PER_CHANNEL_PER_HOUR[channel];
  if (typeof perChannelHourCap === "number") {
    const hourCount = await countSends({
      customerId: input.customerId,
      channel: input.channel,
      sinceMs: ONE_HOUR_MS,
    });
    if (hourCount >= perChannelHourCap) {
      return {
        ok: false,
        bucket: "per_channel_hour",
        reason: `${channel} hourly cap ${perChannelHourCap} reached`,
      };
    }
  }

  // 3. Per-channel daily cap.
  const perChannelDayCap = PER_CHANNEL_PER_DAY[channel];
  if (typeof perChannelDayCap === "number") {
    const dayCount = await countSends({
      customerId: input.customerId,
      channel: input.channel,
      sinceMs: ONE_DAY_MS,
    });
    if (dayCount >= perChannelDayCap) {
      return {
        ok: false,
        bucket: "per_channel_day",
        reason: `${channel} daily cap ${perChannelDayCap} reached`,
      };
    }
  }

  // 4. Across-channel hourly cap per customer.
  const totalHourCount = await countSends({
    customerId: input.customerId,
    sinceMs: ONE_HOUR_MS,
  });
  if (totalHourCount >= TOTAL_PER_HOUR_PER_CUSTOMER) {
    return {
      ok: false,
      bucket: "total_per_hour_customer",
      reason: `customer total hourly cap ${TOTAL_PER_HOUR_PER_CUSTOMER} reached`,
    };
  }

  // 5. Across-channel daily cap per order.
  if (input.orderId) {
    const perOrderDay = await countSends({
      customerId: input.customerId,
      orderId: input.orderId,
      sinceMs: ONE_DAY_MS,
    });
    if (perOrderDay >= TOTAL_PER_DAY_PER_ORDER) {
      return {
        ok: false,
        bucket: "total_per_day_order",
        reason: `order daily cap ${TOTAL_PER_DAY_PER_ORDER} reached`,
      };
    }
  }

  return { ok: true };
}
