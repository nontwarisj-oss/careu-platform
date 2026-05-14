// Engagement Metrics Aggregator — nightly compute that writes
// customer_engagement_daily + customer_lifecycle_status rows.
//
// Why nightly:
//   • The dashboard needs O(1) reads. Computing aggregates per
//     request would be expensive (joining orders + notifications +
//     dispatch_log per customer is not cheap).
//   • Once-daily snapshots align with how operators reason about
//     engagement ("how many at-risk customers today?").
//
// The aggregator is idempotent: running twice on the same day
// re-computes the same UPSERTed values. The cron's heartbeat
// captures rows_processed for observability.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  classifyLifecycle,
  upsertLifecycleStatus,
  type LifecycleInputs,
} from "@/lib/customerLifecycle";
import { resolveNumber } from "@/lib/branchTriggerOverrides";

// ---------- Types -------------------------------------------------------

export type AggregateOptions = {
  /** Process at most this many customers per run. Cron defaults to
   *  500; full-platform sweeps come from multiple ticks. */
  limit?: number;
  /** Compute "as of" this date. Defaults to today (UTC). */
  asOf?: Date;
};

export type AggregateResult = {
  processed: number;
  lifecycleChanges: number;
  rowsWritten: number;
  failures: number;
  asOfDate: string;
  startedAt: string;
  finishedAt: string;
};

type CustomerRow = {
  id: string;
  branch_id: string | null;
  total_orders: number | null;
  lifetime_spend: number | string | null;
  last_visit_at: string | null;
  /** Used to derive daysSinceFirstOrder when we can't cheaply join
   *  orders. The Phase 7 customers row already carries the first
   *  observed order timestamp; if absent we fall back to created_at. */
  created_at: string;
};

// ---------- Per-customer compute ----------------------------------------

function daysSince(iso: string | null, asOf: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((asOf.getTime() - t) / (1000 * 60 * 60 * 24)));
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// ---------- Public entry ------------------------------------------------

export async function runEngagementAggregateTick(
  opts: AggregateOptions = {}
): Promise<AggregateResult> {
  const startedAt = new Date().toISOString();
  const asOf = opts.asOf ?? new Date();
  const asOfDate = asOf.toISOString().slice(0, 10);
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));

  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      processed: 0,
      lifecycleChanges: 0,
      rowsWritten: 0,
      failures: 0,
      asOfDate,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  // Pull the most-recently-active customers first. Idle customers
  // already have stable lifecycle rows so re-classifying them every
  // night is wasteful — but we still process them at the back of the
  // queue periodically. For Phase 18 we just order by last_visit_at
  // and let multiple cron ticks cover the long tail.
  const custRes = await admin
    .from("customers")
    .select(
      "id, branch_id, total_orders, lifetime_spend, last_visit_at, created_at"
    )
    .order("last_visit_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (custRes.error) {
    return {
      processed: 0,
      lifecycleChanges: 0,
      rowsWritten: 0,
      failures: 0,
      asOfDate,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  const customers = (custRes.data ?? []) as CustomerRow[];

  let processed = 0;
  let lifecycleChanges = 0;
  let rowsWritten = 0;
  let failures = 0;

  for (const c of customers) {
    processed += 1;
    const totalOrders = asNumber(c.total_orders);
    const totalSpend = asNumber(c.lifetime_spend);
    const daysSinceVisit = daysSince(c.last_visit_at, asOf);
    const daysSinceFirstOrder = daysSince(c.created_at, asOf);
    const inputs: LifecycleInputs = {
      totalOrders,
      totalSpend,
      daysSinceVisit,
      daysSinceFirstOrder,
    };
    // Per-branch overrides — fall back to HQ defaults inside the
    // resolver. Two values flow into the classifier today.
    const atRiskDays = await resolveNumber({
      branchId: c.branch_id,
      key: "at_risk_days",
      fallback: 90,
    });
    const dormantDays = await resolveNumber({
      branchId: c.branch_id,
      key: "dormant_days",
      fallback: 180,
    });
    const decision = classifyLifecycle(inputs, {
      atRiskDays,
      dormantDays,
    });

    // 1. Upsert lifecycle row.
    try {
      const r = await upsertLifecycleStatus({
        customerId: c.id,
        decision,
        branchId: c.branch_id,
      });
      if (r.ok && r.changed) lifecycleChanges += 1;
      if (r.ok) rowsWritten += 1;
      if (!r.ok) failures += 1;
    } catch {
      failures += 1;
    }

    // 2. Upsert engagement_daily row. Counts of comms / no-shows are
    // computed inline from the per-channel logs for the asOf date.
    try {
      const counts = await computeDailyComms(admin, c.id, asOfDate);
      const avgTicket =
        totalOrders > 0 ? Math.round((totalSpend / totalOrders) * 100) / 100 : 0;
      const upd = await admin.from("customer_engagement_daily").upsert(
        {
          customer_id: c.id,
          metric_date: asOfDate,
          last_order_at: c.last_visit_at,
          total_orders: totalOrders,
          total_spend: totalSpend,
          avg_ticket: avgTicket,
          days_since_last_order: daysSinceVisit,
          sms_sent: counts.smsSent,
          line_sent: counts.lineSent,
          email_sent: counts.emailSent,
          campaign_received_count: counts.campaignReceived,
          campaign_response_count: 0, // tracked once response-capture lands
          no_show_count: 0, // Phase 18 doesn't track no-shows yet
          cancellation_count: counts.cancellations,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "customer_id,metric_date" }
      );
      if (upd.error) failures += 1;
      else rowsWritten += 1;
    } catch {
      failures += 1;
    }
  }

  return {
    processed,
    lifecycleChanges,
    rowsWritten,
    failures,
    asOfDate,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

async function computeDailyComms(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  customerId: string,
  asOfDate: string
): Promise<{
  smsSent: number;
  lineSent: number;
  emailSent: number;
  campaignReceived: number;
  cancellations: number;
}> {
  const dayStart = `${asOfDate}T00:00:00Z`;
  const dayEnd = `${asOfDate}T23:59:59.999Z`;

  // Count dispatched (sent | delivered) per channel for the day.
  const counts = await Promise.all(
    ["sms", "line", "email"].map(async (channel) => {
      const r = await admin
        .from("customer_notifications")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customerId)
        .eq("channel", channel)
        .in("status", ["sent", "delivered"])
        .gte("sent_at", dayStart)
        .lte("sent_at", dayEnd);
      return r.count ?? 0;
    })
  );

  // Campaign sends — count notifications with kind='broadcast' that
  // landed today.
  const campaignRes = await admin
    .from("customer_notifications")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customerId)
    .eq("kind", "broadcast")
    .in("status", ["sent", "delivered"])
    .gte("sent_at", dayStart)
    .lte("sent_at", dayEnd);

  // Cancellations — orders cancelled today by this customer.
  const cancelRes = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customerId)
    .eq("status", "cancelled")
    .gte("updated_at", dayStart)
    .lte("updated_at", dayEnd);

  return {
    smsSent: counts[0],
    lineSent: counts[1],
    emailSent: counts[2],
    campaignReceived: campaignRes.count ?? 0,
    cancellations: cancelRes.count ?? 0,
  };
}
