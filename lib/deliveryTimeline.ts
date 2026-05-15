// Delivery Timeline — the unified per-notification audit trail.
//
// One notification's life is recorded across three tables:
//   • customer_notifications — the queue row (queued / sent /
//     delivered / failed / cancelled milestones + timestamps).
//   • notification_dispatch_log — one row per SEND ATTEMPT
//     (provider accepted / failed / skipped, with attempt number).
//   • communication_events — provider + customer engagement events
//     (delivered / opened / clicked / bounced / complained).
//
// getNotificationTimeline() merges all three into one time-ordered
// list so an operator sees the whole story — queued → dispatched →
// provider accepted → delivered → opened → clicked / failed →
// retried → cancelled — in a single view.
//
// Server-only. Read-only — never mutates.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type TimelineStage =
  | "queued"
  | "dispatched"
  | "provider_accepted"
  | "delivered"
  | "opened"
  | "clicked"
  | "failed"
  | "bounced"
  | "retried"
  | "cancelled"
  | "skipped";

export type TimelineEvent = {
  at: string;
  stage: TimelineStage;
  /** Which table the event came from. */
  source: "notification" | "dispatch_log" | "comm_event";
  detail: string;
};

export type NotificationTimeline = {
  notificationId: string;
  channel: string | null;
  kind: string | null;
  status: string | null;
  events: TimelineEvent[];
};

const STAGE_FROM_OUTCOME: Record<string, TimelineStage> = {
  sent: "provider_accepted",
  failed: "failed",
  skipped: "skipped",
};

const STAGE_FROM_EVENT: Record<string, TimelineStage> = {
  delivered: "delivered",
  opened: "opened",
  clicked: "clicked",
  bounced: "bounced",
  complained: "bounced",
  failed: "failed",
  unsubscribed: "skipped",
};

export async function getNotificationTimeline(
  notificationId: string
): Promise<NotificationTimeline | null> {
  const admin = getSupabaseAdmin();
  if (!admin || !notificationId) return null;

  const notifRes = await admin
    .from("customer_notifications")
    .select(
      "id, channel, kind, status, attempts, error_reason, last_provider_status, created_at, send_after, sent_at, delivered_at, cancelled_at"
    )
    .eq("id", notificationId)
    .maybeSingle();
  const n = notifRes.data as
    | {
        id: string;
        channel: string | null;
        kind: string | null;
        status: string | null;
        attempts: number | null;
        error_reason: string | null;
        last_provider_status: string | null;
        created_at: string;
        send_after: string | null;
        sent_at: string | null;
        delivered_at: string | null;
        cancelled_at: string | null;
      }
    | null;
  if (!n) return null;

  const events: TimelineEvent[] = [];

  // ----- Milestones off the queue row -----
  events.push({
    at: n.created_at,
    stage: "queued",
    source: "notification",
    detail: `queued${n.send_after && n.send_after !== n.created_at ? ` (send_after ${n.send_after})` : ""}`,
  });
  if (n.sent_at) {
    events.push({
      at: n.sent_at,
      stage: "provider_accepted",
      source: "notification",
      detail: n.last_provider_status
        ? `provider accepted (${n.last_provider_status})`
        : "provider accepted the message",
    });
  }
  if (n.delivered_at) {
    events.push({
      at: n.delivered_at,
      stage: "delivered",
      source: "notification",
      detail: "provider confirmed delivery",
    });
  }
  if (n.cancelled_at) {
    events.push({
      at: n.cancelled_at,
      stage: "cancelled",
      source: "notification",
      detail: "cancelled by operator",
    });
  }
  if (n.status === "failed" || n.status === "dead_letter") {
    events.push({
      at: n.delivered_at ?? n.sent_at ?? n.created_at,
      stage: "failed",
      source: "notification",
      detail: `${n.status}${n.error_reason ? `: ${n.error_reason}` : ""}`,
    });
  }

  // ----- Per-attempt dispatch log -----
  try {
    const logRes = await admin
      .from("notification_dispatch_log")
      .select("outcome, attempt, provider, reason, latency_ms, created_at")
      .eq("notification_id", notificationId)
      .order("created_at", { ascending: true });
    const logs = (logRes.data ?? []) as Array<{
      outcome: string;
      attempt: number;
      provider: string | null;
      reason: string | null;
      latency_ms: number | null;
      created_at: string;
    }>;
    for (const l of logs) {
      const stage =
        l.attempt > 1 && l.outcome !== "failed"
          ? "retried"
          : (STAGE_FROM_OUTCOME[l.outcome] ?? "dispatched");
      events.push({
        at: l.created_at,
        stage,
        source: "dispatch_log",
        detail: `attempt ${l.attempt} · ${l.outcome}${
          l.provider ? ` via ${l.provider}` : ""
        }${l.reason ? ` — ${l.reason}` : ""}`,
      });
    }
  } catch {
    // best-effort
  }

  // ----- Provider + engagement events -----
  try {
    const evRes = await admin
      .from("communication_events")
      .select("event_type, provider, target_url, created_at")
      .eq("notification_id", notificationId)
      .order("created_at", { ascending: true });
    const evs = (evRes.data ?? []) as Array<{
      event_type: string;
      provider: string | null;
      target_url: string | null;
      created_at: string;
    }>;
    for (const e of evs) {
      events.push({
        at: e.created_at,
        stage: STAGE_FROM_EVENT[e.event_type] ?? "dispatched",
        source: "comm_event",
        detail: `${e.event_type}${e.provider ? ` (${e.provider})` : ""}${
          e.target_url ? ` → ${e.target_url}` : ""
        }`,
      });
    }
  } catch {
    // best-effort
  }

  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return {
    notificationId,
    channel: n.channel,
    kind: n.kind,
    status: n.status,
    events,
  };
}
