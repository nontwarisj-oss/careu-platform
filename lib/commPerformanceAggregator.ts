// Communications Performance Aggregator — nightly compute that
// populates communication_performance_daily.
//
// Source tables:
//   • customer_notifications     — send + delivery counts
//   • communication_events       — open + click + bounce + unsub
//   • notification_dispatch_log  — provider latency
//
// Output table is per (branch_id, channel, metric_date) so the
// dashboard can show "Saladaeng SMS yesterday" without joining.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const CHANNELS = ["sms", "line", "email"];

export type AggregateOptions = {
  /** Compute "as of" this date. Defaults to yesterday so the day's
   *  data has time to settle (provider webhooks can lag). */
  asOf?: Date;
};

export type AggregateResult = {
  date: string;
  rowsWritten: number;
  branches: number;
};

export async function runCommPerformanceAggregateTick(
  opts: AggregateOptions = {}
): Promise<AggregateResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { date: "", rowsWritten: 0, branches: 0 };

  const target = opts.asOf ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const metricDate = target.toISOString().slice(0, 10);
  const dayStart = `${metricDate}T00:00:00Z`;
  const dayEnd = `${metricDate}T23:59:59.999Z`;

  // Find all branches that produced any notification activity that
  // day. Wrap with a "global" bucket for branch_id IS NULL rows.
  const branchesRes = await admin
    .from("customer_notifications")
    .select("branch_id")
    .gte("created_at", dayStart)
    .lte("created_at", dayEnd)
    .limit(2000);
  const branchSet = new Set<string | null>();
  ((branchesRes.data ?? []) as Array<{ branch_id: string | null }>).forEach(
    (r) => branchSet.add(r.branch_id)
  );

  // Helper that adds the (branch, day window) filter to any HEAD
  // count query. Inlined rather than extracted because the postgrest
  // chained-builder types don't compose cleanly across function
  // boundaries.

  let rowsWritten = 0;
  for (const branchId of branchSet) {
    for (const channel of CHANNELS) {
      // customer_notifications counts
      let sentQ = admin
        .from("customer_notifications")
        .select("id", { count: "exact", head: true })
        .eq("channel", channel)
        .in("status", ["sent", "delivered"])
        .gte("created_at", dayStart)
        .lte("created_at", dayEnd);
      sentQ =
        branchId === null
          ? sentQ.is("branch_id", null)
          : sentQ.eq("branch_id", branchId);
      const sentRes = await sentQ;

      let deliveredQ = admin
        .from("customer_notifications")
        .select("id", { count: "exact", head: true })
        .eq("channel", channel)
        .eq("status", "delivered")
        .gte("created_at", dayStart)
        .lte("created_at", dayEnd);
      deliveredQ =
        branchId === null
          ? deliveredQ.is("branch_id", null)
          : deliveredQ.eq("branch_id", branchId);
      const deliveredRes = await deliveredQ;

      let failedQ = admin
        .from("customer_notifications")
        .select("id", { count: "exact", head: true })
        .eq("channel", channel)
        .in("status", ["failed", "dead_letter"])
        .gte("created_at", dayStart)
        .lte("created_at", dayEnd);
      failedQ =
        branchId === null
          ? failedQ.is("branch_id", null)
          : failedQ.eq("branch_id", branchId);
      const failedRes = await failedQ;

      // communication_events counts — wrap in a small per-type helper
      // so the four counts share the same filter logic.
      const eventCount = async (type: string) => {
        let q = admin
          .from("communication_events")
          .select("id", { count: "exact", head: true })
          .eq("channel", channel)
          .eq("event_type", type)
          .gte("created_at", dayStart)
          .lte("created_at", dayEnd);
        q = branchId === null ? q.is("branch_id", null) : q.eq("branch_id", branchId);
        return q;
      };
      const openedRes = await eventCount("opened");
      const clickedRes = await eventCount("clicked");
      const bouncedRes = await eventCount("bounced");
      const unsubRes = await eventCount("unsubscribed");

      // Average dispatch latency from notification_dispatch_log.
      const latencyRes = await admin
        .from("notification_dispatch_log")
        .select("latency_ms")
        .eq("channel", channel)
        .eq("outcome", "sent")
        .gte("created_at", dayStart)
        .lte("created_at", dayEnd)
        .limit(500);
      const latencies =
        latencyRes.data && Array.isArray(latencyRes.data)
          ? (latencyRes.data as Array<{ latency_ms: number | null }>)
              .map((r) => r.latency_ms)
              .filter((v): v is number => typeof v === "number")
          : [];
      const avgLatency =
        latencies.length > 0
          ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
          : null;

      const sent = sentRes.count ?? 0;
      const delivered = deliveredRes.count ?? 0;
      const failed = failedRes.count ?? 0;
      const opened = openedRes.count ?? 0;
      const clicked = clickedRes.count ?? 0;
      const bounced = bouncedRes.count ?? 0;
      const unsub = unsubRes.count ?? 0;

      // Skip writing zero-everything rows — keeps the table tidy.
      if (
        sent === 0 &&
        failed === 0 &&
        opened === 0 &&
        clicked === 0 &&
        bounced === 0 &&
        unsub === 0
      ) {
        continue;
      }

      await admin.from("communication_performance_daily").upsert(
        {
          branch_id: branchId,
          channel,
          metric_date: metricDate,
          sent_count: sent,
          delivered_count: delivered,
          opened_count: opened,
          clicked_count: clicked,
          bounced_count: bounced,
          unsubscribed_count: unsub,
          failed_count: failed,
          avg_latency_ms: avgLatency,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "branch_id,channel,metric_date" }
      );
      rowsWritten += 1;
    }
  }

  return {
    date: metricDate,
    rowsWritten,
    branches: branchSet.size,
  };
}
