// Delivery Confirmation — the idempotent bridge between provider
// webhooks and the alert-delivery audit trail.
//
// Customer-notification delivery confirmation already flows through
// the webhooks (customer_notifications + communication_events +
// broadcast_metrics_daily — Phases 19–21). What Phase 24 adds is
// confirmation for OPERATOR ALERT emails: an alert email carries a
// provider message id (Resend email_id) stored on its
// alert_deliveries row at send time. When Resend later reports the
// outcome, this helper flips that row sent → delivered / failed.
//
// Idempotency: status only moves FORWARD. 'delivered' and 'failed'
// are terminal; a duplicate or out-of-order webhook is a no-op.
//
// Server-only. Best-effort — never throws.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

/** Forward-only rank. A webhook may only raise an alert_deliveries
 *  row's status, never lower it. */
const STATUS_RANK: Record<string, number> = {
  skipped: 0,
  sent: 1,
  delivered: 2,
  failed: 2,
};

export type AlertConfirmStatus = "delivered" | "failed";

/**
 * Confirm an operator-alert email by its provider message id.
 * Returns the number of alert_deliveries rows advanced (0 when the
 * id belongs to a customer notification, not an alert — that is the
 * normal case and not an error).
 */
export async function confirmAlertEmailDelivery(opts: {
  providerMessageId: string;
  status: AlertConfirmStatus;
  reason?: string;
}): Promise<number> {
  const admin = getSupabaseAdmin();
  if (!admin || !opts.providerMessageId) return 0;

  try {
    const res = await admin
      .from("alert_deliveries")
      .select("id, status")
      .eq("provider_message_id", opts.providerMessageId)
      .eq("channel", "email");
    const rows = (res.data ?? []) as Array<{ id: string; status: string }>;
    if (rows.length === 0) return 0;

    const targetRank = STATUS_RANK[opts.status] ?? 0;
    let advanced = 0;
    for (const row of rows) {
      const curRank = STATUS_RANK[row.status] ?? 0;
      // Forward-only: skip rows already at or past the target rank.
      if (curRank >= targetRank) continue;
      const upd = await admin
        .from("alert_deliveries")
        .update({
          status: opts.status,
          detail: {
            confirmedAt: new Date().toISOString(),
            reason: opts.reason ?? `provider reported ${opts.status}`,
          },
        })
        .eq("id", row.id)
        .eq("status", row.status); // optimistic — lost race = no-op
      if (!upd.error) advanced += 1;
    }
    return advanced;
  } catch (err) {
    console.warn(
      "[delivery-confirmation] alert confirm failed",
      err instanceof Error ? err.message : String(err)
    );
    return 0;
  }
}
