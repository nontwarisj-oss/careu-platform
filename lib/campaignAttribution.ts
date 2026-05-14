// Campaign Attribution — links a customer's order to a recent
// campaign send (broadcast send_job or retention trigger).
//
// Attribution window: 14 days. When a customer places an order
// within that window of receiving a campaign, we write a row to
// campaign_response_metrics linking the campaign source → order →
// revenue.
//
// "Newest campaign wins" — if a customer received both a broadcast
// and a retention trigger within the window, the most recent one is
// credited. The unique index on (source_kind, source_id, customer_id)
// prevents double-credit for the same campaign.
//
// Server-only. Called from the order-creation path so attribution
// happens in real time; can also be back-filled by a script.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const ATTRIBUTION_WINDOW_DAYS = 14;

export type AttributionInput = {
  orderId: string;
  customerId: string;
  orderValue: number;
  branchId: string | null;
};

export type AttributionResult = {
  ok: boolean;
  attributed: boolean;
  sourceKind?: "broadcast_send_job" | "retention_trigger";
  sourceId?: string;
  recoveredDormant?: boolean;
  reason?: string;
};

/**
 * Look back ATTRIBUTION_WINDOW_DAYS from now for the most recent
 * campaign send to this customer. When found, write a
 * campaign_response_metrics row. Idempotent — the unique index
 * (source_kind, source_id, customer_id) prevents double-attribution.
 */
export async function attributeOrderToCampaign(
  input: AttributionInput
): Promise<AttributionResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, attributed: false, reason: "no admin client" };
  }
  const since = new Date(
    Date.now() - ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  // Look up the most recent campaign-shaped notification sent to
  // this customer. We use customer_notifications.kind in {broadcast,
  // retention} to identify campaign sends without joining other
  // tables.
  const recent = await admin
    .from("customer_notifications")
    .select("id, kind, payload, branch_id, sent_at, delivered_at, created_at")
    .eq("customer_id", input.customerId)
    .in("kind", ["broadcast", "retention"])
    .in("status", ["sent", "delivered"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recent.error || !recent.data) {
    return {
      ok: true,
      attributed: false,
      reason: "no recent campaign send found",
    };
  }
  const notif = recent.data as {
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    branch_id: string | null;
    sent_at: string | null;
    delivered_at: string | null;
    created_at: string;
  };

  let sourceKind: "broadcast_send_job" | "retention_trigger";
  let sourceId: string | null = null;
  if (notif.kind === "broadcast") {
    sourceKind = "broadcast_send_job";
    sourceId =
      typeof notif.payload?.broadcastJobId === "string"
        ? (notif.payload.broadcastJobId as string)
        : null;
  } else {
    sourceKind = "retention_trigger";
    // retention_trigger_jobs row id isn't stored in the notification
    // payload today; fall back to looking up the most-recent trigger
    // row for the same customer.
    const triggerRes = await admin
      .from("retention_trigger_jobs")
      .select("id")
      .eq("customer_id", input.customerId)
      .eq("notification_id", notif.id)
      .limit(1)
      .maybeSingle();
    sourceId =
      (triggerRes.data as { id: string } | null)?.id ?? null;
  }
  if (!sourceId) {
    return {
      ok: true,
      attributed: false,
      reason: "campaign source id not resolvable",
    };
  }

  // Lifecycle check — was this customer dormant at send time? Quick
  // proxy: their current lifecycle status, since we haven't snapshotted
  // it at send time.
  const lifecycleRes = await admin
    .from("customer_lifecycle_status")
    .select("status, previous_status, changed_at")
    .eq("customer_id", input.customerId)
    .maybeSingle();
  const lifecycle = lifecycleRes.data as
    | { status: string; previous_status: string | null; changed_at: string | null }
    | null;
  const recoveredDormant =
    !!lifecycle &&
    (lifecycle.previous_status === "dormant" ||
      lifecycle.previous_status === "at_risk");

  const sentAt = notif.sent_at ?? notif.delivered_at ?? notif.created_at;
  const respondedAt = new Date().toISOString();
  const responseDays = Math.max(
    0,
    Math.floor(
      (new Date(respondedAt).getTime() - new Date(sentAt).getTime()) /
        (1000 * 60 * 60 * 24)
    )
  );

  const ins = await admin.from("campaign_response_metrics").insert({
    customer_id: input.customerId,
    source_kind: sourceKind,
    source_id: sourceId,
    order_id: input.orderId,
    sent_at: sentAt,
    responded_at: respondedAt,
    response_days: responseDays,
    order_value_thb: input.orderValue,
    recovered_dormant: recoveredDormant,
    branch_id: input.branchId,
  });
  if (ins.error) {
    // Duplicate-key hit means we already attributed this (source,
    // customer) — treat as success.
    if (/duplicate key|campaign_response_metrics_unique/i.test(ins.error.message ?? "")) {
      return {
        ok: true,
        attributed: false,
        sourceKind,
        sourceId,
        reason: "already attributed",
      };
    }
    return { ok: false, attributed: false, reason: ins.error.message };
  }
  return {
    ok: true,
    attributed: true,
    sourceKind,
    sourceId,
    recoveredDormant,
  };
}
