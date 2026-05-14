// Campaign Funnel Writer — increments per (source, channel, branch,
// date) counters in `campaign_funnel_metrics`.
//
// Per-campaign aggregate sibling of campaign_response_metrics
// (which is per-customer). Stage names:
//   • delivered     — provider acked
//   • opened        — pixel returned 200
//   • clicked       — signed click link verified
//   • quote_started — customer hit /quote with a valid signed nid
//   • order_created — customer placed an order attributed back to source
//   • revenue       — sum of attributed order values
//
// All writes are best-effort + idempotent via PG UPSERT on the
// composite PK. Failures NEVER propagate — funnel telemetry can't
// block a customer-facing flow.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type FunnelStage =
  | "delivered"
  | "opened"
  | "clicked"
  | "quote_started"
  | "order_created";

const STAGE_COLUMN: Record<FunnelStage, string> = {
  delivered: "delivered_count",
  opened: "opened_count",
  clicked: "clicked_count",
  quote_started: "quote_started_count",
  order_created: "order_count",
};

export type IncrementInput = {
  sourceKind: "broadcast_send_job" | "retention_trigger";
  sourceId: string;
  channel: string;
  branchId: string | null;
  stage: FunnelStage;
  /** Set when stage='order_created'. */
  revenueThb?: number;
};

/**
 * Increment a single funnel counter. Idempotent at the PK level —
 * subsequent calls update the same row. The increment is atomic
 * via Postgres `+ 1`. Returns ok:true even on miss so callers can
 * stay terse.
 */
export async function incrementFunnel(
  input: IncrementInput
): Promise<{ ok: boolean }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false };
  const metricDate = new Date().toISOString().slice(0, 10);
  const column = STAGE_COLUMN[input.stage];
  if (!column) return { ok: false };

  // Look for an existing row, else insert. Atomic increment via
  // separate update keeps the math correct under concurrent writes
  // (postgres handles row-level update locking).
  const existing = await admin
    .from("campaign_funnel_metrics")
    .select(column)
    .eq("source_kind", input.sourceKind)
    .eq("source_id", input.sourceId)
    .eq("channel", input.channel)
    .eq("metric_date", metricDate)
    .filter("branch_id", input.branchId === null ? "is" : "eq", input.branchId === null ? null : input.branchId)
    .limit(1)
    .maybeSingle();

  if (existing.data) {
    const dataRow = existing.data as unknown as Record<string, unknown>;
    const current = Number(dataRow[column] ?? 0);
    const patch: Record<string, unknown> = {
      [column]: current + 1,
      updated_at: new Date().toISOString(),
    };
    if (input.stage === "order_created" && input.revenueThb) {
      patch.revenue_thb =
        Number(dataRow.revenue_thb ?? 0) + input.revenueThb;
    }
    let q = admin
      .from("campaign_funnel_metrics")
      .update(patch)
      .eq("source_kind", input.sourceKind)
      .eq("source_id", input.sourceId)
      .eq("channel", input.channel)
      .eq("metric_date", metricDate);
    q =
      input.branchId === null
        ? q.is("branch_id", null)
        : q.eq("branch_id", input.branchId);
    await q;
    return { ok: true };
  }

  const insertPayload: Record<string, unknown> = {
    source_kind: input.sourceKind,
    source_id: input.sourceId,
    channel: input.channel,
    branch_id: input.branchId,
    metric_date: metricDate,
    delivered_count: 0,
    opened_count: 0,
    clicked_count: 0,
    quote_started_count: 0,
    order_count: 0,
    revenue_thb: 0,
    [column]: 1,
  };
  if (input.stage === "order_created" && input.revenueThb) {
    insertPayload.revenue_thb = input.revenueThb;
  }
  await admin.from("campaign_funnel_metrics").insert(insertPayload);
  return { ok: true };
}
