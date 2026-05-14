// Lifecycle event notifier — the single point that converts "this just
// happened to the order" into queue rows the dispatch worker will send.
//
// Why a separate module from lib/lineDelivery.ts:
//   • lineDelivery is the LEGACY immediate-send LINE path. It uses
//     line_message_log + customer_line_links + lineMessageBuilders.
//     The OPS UI still calls it directly from a few places; we leave
//     it alone this phase.
//   • lifecycleNotifier is the NEW preference-aware ASYNC path. It
//     writes to customer_notifications (the dispatch queue) for SMS
//     AND LINE, consults customer_notification_preferences, dedups,
//     and never blocks the request cycle.
//
// Trigger contract:
//   notifyLifecycleEvent({ event, orderId, actorId? })
//     • event       — order_created | repair_started | ready_for_pickup
//                     | order_completed | overdue_pickup | payment_received
//     • orderId     — UUID of the order row
//     • actorId     — operator UUID (optional — audit only)
//
// Returns a per-channel summary so the caller can log success metrics
// without throwing. The function NEVER throws — every error is captured.
//
// Dedup semantics:
//   For each {customer_id, kind, order_id}, at most ONE queued or
//   recently-sent notification per channel within DEDUP_WINDOW_MS.
//   This means double-clicking "mark ready" on the OPS UI doesn't
//   send two SMS to the customer.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { enqueueNotification } from "@/lib/notificationService";
import {
  renderNotification,
  preferenceFieldFor,
  type NotificationKind,
  type CustomerTier,
} from "@/lib/notificationTemplates";
import { getBranchById, branches } from "@/lib/brandConfig";

// ---------- Tunables -----------------------------------------------------

/** Within this window, an identical (customer, kind, order_id) on the
 *  same channel will NOT re-enqueue. 6 h handles double-clicks, retries
 *  from the OPS UI, and the cron sweeping the same overdue order
 *  multiple times in one shift. */
export const DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;

// ---------- Types ---------------------------------------------------------

export type LifecycleEvent =
  | "order_created"
  | "repair_started"
  | "ready_for_pickup"
  | "order_completed"
  | "overdue_pickup"
  | "payment_received";

export type NotifyChannel = "sms" | "line";

export type NotifyOutcome = {
  channel: NotifyChannel;
  enqueued: boolean;
  reason: string | null;
  notificationId: string | null;
};

export type NotifyResult = {
  ok: boolean;
  event: LifecycleEvent;
  orderId: string;
  customerId: string | null;
  outcomes: NotifyOutcome[];
  /** When non-null, the whole event was skipped (e.g. no customer
   *  attached to the order). The outcomes array stays empty. */
  skippedReason: string | null;
};

type OrderRow = {
  id: string;
  customer_id: string | null;
  branch_id: string | null;
  job_id: string | null;
  status: string | null;
  payment_status: string | null;
  service_name: string | null;
  item_name: string | null;
  price: number | null;
  due_date: string | null;
};

type CustomerRow = {
  id: string;
  name: string | null;
  phone: string | null;
  normalized_phone: string | null;
  customer_tier: string | null;
  branch_id: string | null;
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

// ---------- Helpers -------------------------------------------------------

function eventToKind(event: LifecycleEvent): NotificationKind {
  switch (event) {
    case "order_created":
      return "order_created";
    case "repair_started":
      return "repair_started";
    case "ready_for_pickup":
      return "ready_for_pickup";
    case "order_completed":
      return "order_completed";
    case "overdue_pickup":
      return "overdue_pickup";
    case "payment_received":
      return "payment_received";
  }
}

/** Resolve a BranchConfig from a branch slug or any of the brandConfig
 *  identifiers. Falls back to the default brand. */
function resolveBranchBrand(branchSlug: string | null) {
  if (!branchSlug) return getBranchById(null);
  // The branches.code in DB matches BranchConfig.id (slug form). The
  // brandConfig list is short — a linear scan is fine.
  const hit = branches.find(
    (b) =>
      b.id === branchSlug ||
      b.branchCode === branchSlug ||
      b.shortName.toLowerCase() === branchSlug.toLowerCase()
  );
  return hit ?? getBranchById(null);
}

function tierFromColumn(value: string | null): CustomerTier {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "bronze") return "bronze";
  if (v === "silver") return "silver";
  if (v === "gold") return "gold";
  if (v === "platinum") return "platinum";
  if (v === "vip") return "vip";
  return null;
}

function refFor(order: OrderRow): string {
  if (order.job_id && order.job_id.trim()) return order.job_id;
  return `#${order.id.slice(0, 8).toUpperCase()}`;
}

function serviceFor(order: OrderRow): string | null {
  if (order.service_name && order.service_name.trim()) return order.service_name;
  if (order.item_name && order.item_name.trim()) return order.item_name;
  return null;
}

function fmtDueLabel(due: string | null): string | null {
  if (!due) return null;
  try {
    return new Date(due).toLocaleDateString("th-TH", {
      dateStyle: "medium",
    });
  } catch {
    return due;
  }
}

function amountOwedFor(order: OrderRow): number {
  if (!order.price) return 0;
  if (order.payment_status === "paid") return 0;
  return Number(order.price);
}

// ---------- Dedup --------------------------------------------------------

async function alreadyEnqueuedRecently(opts: {
  customerId: string | null;
  kind: string;
  orderId: string;
  channel: NotifyChannel;
}): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;
  const since = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
  // The queue holds one row per intent; we look for a recent row with
  // the same kind + same orderId in payload. Branch + customer scope
  // also enforced.
  let q = admin
    .from("customer_notifications")
    .select("id, status")
    .eq("kind", opts.kind)
    .eq("channel", opts.channel)
    .gte("created_at", since);
  if (opts.customerId) q = q.eq("customer_id", opts.customerId);
  // payload->>'orderId' must match. Postgres handles the JSON cast.
  q = q.eq("payload->>orderId", opts.orderId);
  const res = await q.limit(1).maybeSingle();
  if (res.error) {
    // On infra error, fail open (allow enqueue) — better to risk a
    // duplicate than to lose a notification entirely.
    return false;
  }
  if (!res.data) return false;
  const status = (res.data as { status: string }).status;
  // Treat anything that's not finally-failed as a duplicate. A row
  // that already failed permanently SHOULD be retried; queued / sending
  // / sent / skipped should NOT.
  return status !== "failed";
}

// ---------- Preference resolver -------------------------------------------

async function getPreferences(customerId: string): Promise<PrefsRow> {
  const admin = getSupabaseAdmin();
  if (!admin) return DEFAULT_PREFS;
  const res = await admin
    .from("customer_notification_preferences")
    .select(
      "sms_enabled, line_enabled, email_enabled, pickup_reminders, order_status_alerts, payment_alerts, promotional"
    )
    .eq("customer_id", customerId)
    .maybeSingle();
  if (res.error || !res.data) return DEFAULT_PREFS;
  return res.data as PrefsRow;
}

function channelEnabledForKind(
  prefs: PrefsRow,
  channel: NotifyChannel,
  kind: NotificationKind
): { ok: boolean; reason: string | null } {
  const channelMaster =
    channel === "sms" ? prefs.sms_enabled : prefs.line_enabled;
  if (!channelMaster) {
    return {
      ok: false,
      reason: `customer disabled ${channel.toUpperCase()} channel`,
    };
  }
  const field = preferenceFieldFor(kind);
  if (field === "transactional") return { ok: true, reason: null };
  if (field === "pickup_reminders" && !prefs.pickup_reminders) {
    return { ok: false, reason: "customer disabled pickup reminders" };
  }
  if (field === "order_status_alerts" && !prefs.order_status_alerts) {
    return { ok: false, reason: "customer disabled order status alerts" };
  }
  if (field === "payment_alerts" && !prefs.payment_alerts) {
    return { ok: false, reason: "customer disabled payment alerts" };
  }
  if (field === "promotional" && !prefs.promotional) {
    return { ok: false, reason: "customer not opted-in to promotional" };
  }
  return { ok: true, reason: null };
}

// ---------- LINE link resolver -------------------------------------------

async function resolveLineUserId(customerId: string): Promise<string | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const res = await admin
    .from("customer_line_links")
    .select("line_user_id, unsubscribed_at")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (res.error || !res.data) return null;
  const row = res.data as {
    line_user_id: string;
    unsubscribed_at: string | null;
  };
  if (row.unsubscribed_at) return null;
  return row.line_user_id;
}

// ---------- Audit helper -------------------------------------------------

async function writeAudit(
  orderId: string,
  event: LifecycleEvent,
  outcomes: NotifyOutcome[],
  actorId: string | null
): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  try {
    await admin.from("order_audit_log").insert({
      order_id: orderId,
      action: "lifecycle_notified",
      before_value: event,
      after_value: JSON.stringify(
        outcomes.map((o) => ({
          channel: o.channel,
          enqueued: o.enqueued,
          reason: o.reason,
        }))
      ),
      changed_by: actorId,
    });
  } catch {
    // Audit failures must never propagate.
  }
}

// ---------- Entry point ---------------------------------------------------

export type NotifyLifecycleInput = {
  event: LifecycleEvent;
  orderId: string;
  actorId?: string | null;
  /** Bypass the 6-hour dedup window. Operator manual sends use this
   *  ("resend pickup reminder") — they know they're re-firing. The
   *  per-customer rate limiter still applies (that's the real spam
   *  guard). */
  force?: boolean;
};

export async function notifyLifecycleEvent(
  input: NotifyLifecycleInput
): Promise<NotifyResult> {
  const { event, orderId } = input;
  const actorId = input.actorId ?? null;
  const result: NotifyResult = {
    ok: true,
    event,
    orderId,
    customerId: null,
    outcomes: [],
    skippedReason: null,
  };

  const admin = getSupabaseAdmin();
  if (!admin) {
    result.ok = false;
    result.skippedReason = "service-role admin client not configured";
    return result;
  }

  // 1. Load the order with the fields the template needs.
  const orderRes = await admin
    .from("orders")
    .select(
      "id, customer_id, branch_id, job_id, status, payment_status, service_name, item_name, price, due_date"
    )
    .eq("id", orderId)
    .maybeSingle();
  if (orderRes.error || !orderRes.data) {
    result.ok = false;
    result.skippedReason = orderRes.error?.message ?? "order not found";
    return result;
  }
  const order = orderRes.data as OrderRow;
  if (!order.customer_id) {
    result.skippedReason = "order has no customer_id — walk-in?";
    return result;
  }
  result.customerId = order.customer_id;

  // 2. Load the customer + preferences in parallel.
  const customerPromise = admin
    .from("customers")
    .select("id, name, phone, normalized_phone, customer_tier, branch_id")
    .eq("id", order.customer_id)
    .maybeSingle();
  const prefsPromise = getPreferences(order.customer_id);
  const linePromise = resolveLineUserId(order.customer_id);
  const [customerRes, prefs, lineUserId] = await Promise.all([
    customerPromise,
    prefsPromise,
    linePromise,
  ]);
  if (customerRes.error || !customerRes.data) {
    result.skippedReason =
      customerRes.error?.message ?? "customer row missing for order";
    return result;
  }
  const customer = customerRes.data as CustomerRow;

  // 3. Resolve branch + render template.
  const branchSlug = order.branch_id ?? customer.branch_id;
  const branch = resolveBranchBrand(branchSlug);
  const kind = eventToKind(event);
  const rendered = renderNotification({
    kind,
    branch: {
      receiptName: branch.receiptName,
      shortLabel: branch.shortLabel,
      address: branch.address,
    },
    customerName: customer.name,
    tier: tierFromColumn(customer.customer_tier),
    ref: refFor(order),
    service: serviceFor(order),
    amountOwed: amountOwedFor(order),
    amountPaid:
      event === "payment_received" && order.price
        ? Number(order.price)
        : undefined,
    dueLabel: fmtDueLabel(order.due_date),
  });

  const phone = customer.normalized_phone || customer.phone;

  // 4. Per-channel enqueue. SMS first (faster fallback), LINE second
  //    (richer for customers who follow).
  const channels: Array<{
    channel: NotifyChannel;
    targetField: string;
    target: string | null;
    body: string;
  }> = [
    { channel: "sms", targetField: "phone", target: phone, body: rendered.sms },
    {
      channel: "line",
      targetField: "lineUserId",
      target: lineUserId,
      body: rendered.line,
    },
  ];

  for (const ch of channels) {
    const gated = channelEnabledForKind(prefs, ch.channel, kind);
    if (!gated.ok) {
      result.outcomes.push({
        channel: ch.channel,
        enqueued: false,
        reason: gated.reason,
        notificationId: null,
      });
      continue;
    }
    if (!ch.target) {
      result.outcomes.push({
        channel: ch.channel,
        enqueued: false,
        reason: `no ${ch.targetField} for customer`,
        notificationId: null,
      });
      continue;
    }
    const isDup =
      input.force === true
        ? false
        : await alreadyEnqueuedRecently({
            customerId: order.customer_id,
            kind,
            orderId: order.id,
            channel: ch.channel,
          });
    if (isDup) {
      result.outcomes.push({
        channel: ch.channel,
        enqueued: false,
        reason: "dedup: identical notification within window",
        notificationId: null,
      });
      continue;
    }
    const payload: Record<string, unknown> = {
      orderId: order.id,
      ref: refFor(order),
      body: ch.body,
      event,
      branchSlug: branchSlug ?? null,
    };
    if (ch.channel === "sms") payload.phone = ch.target;
    if (ch.channel === "line") payload.lineUserId = ch.target;
    const enq = await enqueueNotification({
      customerId: order.customer_id,
      branchId: branchSlug,
      channel: ch.channel,
      kind,
      payload,
      actorId,
    });
    if (enq.ok) {
      result.outcomes.push({
        channel: ch.channel,
        enqueued: true,
        reason: null,
        notificationId: enq.notificationId,
      });
    } else {
      result.outcomes.push({
        channel: ch.channel,
        enqueued: false,
        reason: enq.reason,
        notificationId: null,
      });
    }
  }

  // 5. Audit. Best-effort.
  await writeAudit(orderId, event, result.outcomes, actorId);

  return result;
}
