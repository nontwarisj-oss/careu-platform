// Broadcast delivery callback — extends the existing webhook handlers
// (email, twilio, line-status) so they don't only update
// customer_notifications but also keep broadcast_metrics_daily fresh
// when the notification originated from a broadcast send_job.
//
// Why this exists:
//
//   Phase 16 wrote broadcast_metrics_daily from inside the
//   broadcast send worker, but those counters were only "we
//   enqueued N" — they never updated when the provider later told
//   us the message was actually delivered (or bounced).
//
//   Operators want to see delivery rate per broadcast on the
//   engagement dashboard, so we have to teach the webhook layer
//   to look up the target row and bump the right daily-metric
//   column.
//
//   Phase 21: also writes the per-funnel "delivered" stage on
//   campaign_funnel_metrics when a broadcast notification is
//   confirmed delivered. The funnel writer was added in Phase 20
//   but never auto-wired from the webhook.
//
// Server-only. Best-effort: failures here don't propagate to the
// webhook caller — the customer_notifications row is the
// source-of-truth and a webhook retry will re-do the work.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { incrementFunnel } from "@/lib/campaignFunnel";

export type DeliveryStage = "delivered" | "failed" | "opened" | "clicked";

const STAGE_COLUMN: Record<DeliveryStage, string | null> = {
  delivered: "delivered_count",
  failed: "failed_count",
  // Open + click already live on communication_events and the
  // engagement dashboard's perf-aggregator rolls them up nightly.
  // We don't double-count them on broadcast_metrics_daily.
  opened: null,
  clicked: null,
};

/**
 * Best-effort: a notification's status just changed (from a provider
 * webhook). If that notification is part of a broadcast send_job,
 * increment the matching broadcast_metrics_daily counter.
 *
 * Also writes the campaign-level funnel stage for the broadcast — so
 * the funnel dashboard's "delivered" column finally gets data.
 */
export async function maybeRecordBroadcastDelivery(opts: {
  notificationId: string;
  stage: DeliveryStage;
}): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;

  try {
    // 1. Is this notification a broadcast target? One round-trip pulls
    //    the linked target row + send_job context.
    const targetRes = await admin
      .from("broadcast_send_targets")
      .select(
        "send_job_id, channel, broadcast_send_jobs!inner(branch_id)"
      )
      .eq("notification_id", opts.notificationId)
      .maybeSingle();
    const target = targetRes.data as
      | {
          send_job_id: string;
          channel: string;
          broadcast_send_jobs: { branch_id: string | null } | null;
        }
      | null;
    if (!target) return;

    const branchId = target.broadcast_send_jobs?.branch_id ?? null;

    // 2. Bump broadcast_metrics_daily.
    const col = STAGE_COLUMN[opts.stage];
    if (col) {
      const today = new Date().toISOString().slice(0, 10);
      const existing = await admin
        .from("broadcast_metrics_daily")
        .select("send_job_id, queued_count, sent_count, delivered_count, failed_count, skipped_count, opted_out_count, deduped_count")
        .eq("send_job_id", target.send_job_id)
        .eq("metric_date", today)
        .eq("channel", target.channel)
        .maybeSingle();

      type RowShape = {
        send_job_id: string;
        queued_count: number;
        sent_count: number;
        delivered_count: number;
        failed_count: number;
        skipped_count: number;
        opted_out_count: number;
        deduped_count: number;
      };
      const row = existing.data as RowShape | null;
      const nextValue =
        ((row?.[col as keyof RowShape] as number | undefined) ?? 0) + 1;

      if (row) {
        await admin
          .from("broadcast_metrics_daily")
          .update({
            [col]: nextValue,
            updated_at: new Date().toISOString(),
          })
          .eq("send_job_id", target.send_job_id)
          .eq("metric_date", today)
          .eq("channel", target.channel);
      } else {
        // Insert the daily row with a one-bump on the relevant column.
        await admin.from("broadcast_metrics_daily").insert({
          send_job_id: target.send_job_id,
          metric_date: today,
          channel: target.channel,
          queued_count: 0,
          sent_count: 0,
          delivered_count: opts.stage === "delivered" ? 1 : 0,
          failed_count: opts.stage === "failed" ? 1 : 0,
          skipped_count: 0,
          opted_out_count: 0,
          deduped_count: 0,
        });
      }
    }

    // 3. Bump campaign_funnel_metrics (Phase 20 funnel writer).
    //    Only 'delivered' rolls up to the funnel — failures don't
    //    contribute (we already capture failures in broadcast_metrics_daily).
    if (opts.stage === "delivered") {
      await incrementFunnel({
        sourceKind: "broadcast_send_job",
        sourceId: target.send_job_id,
        channel: target.channel,
        branchId,
        stage: "delivered",
      });
    }
    if (opts.stage === "opened") {
      await incrementFunnel({
        sourceKind: "broadcast_send_job",
        sourceId: target.send_job_id,
        channel: target.channel,
        branchId,
        stage: "opened",
      });
    }
    if (opts.stage === "clicked") {
      await incrementFunnel({
        sourceKind: "broadcast_send_job",
        sourceId: target.send_job_id,
        channel: target.channel,
        branchId,
        stage: "clicked",
      });
    }
  } catch (err) {
    console.warn(
      "[broadcast-delivery-callback] failed",
      err instanceof Error ? err.message : String(err)
    );
  }
}
