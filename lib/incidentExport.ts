// Incident Snapshot Export — bundles everything an operator (or a
// support escalation) needs to understand one incident into a single
// downloadable package, as JSON or a markdown summary.
//
// Two incident kinds:
//   • notification — keyed by a notification id: the delivery
//     timeline + the per-attempt dispatch log + provider webhook
//     payloads + retry history.
//   • alert        — keyed by an alert_events id: the alert + its
//     escalation chain (alert_deliveries) + the cron heartbeats
//     around the time it fired.
//
// Server-only. Read-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getNotificationTimeline } from "@/lib/deliveryTimeline";

export type IncidentPackage = {
  kind: "notification" | "alert";
  generatedAt: string;
  subject: string;
  summary: Record<string, unknown>;
  timeline: unknown[];
  records: Record<string, unknown[]>;
};

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

async function rows(
  admin: Admin,
  table: string,
  build: (q: ReturnType<Admin["from"]>) => unknown
): Promise<unknown[]> {
  try {
    const res = (await build(admin.from(table))) as {
      data?: unknown[];
      error?: unknown;
    };
    return Array.isArray(res.data) ? res.data : [];
  } catch {
    return [];
  }
}

/** Build a notification-centric incident package. */
async function notificationPackage(
  admin: Admin,
  notificationId: string
): Promise<IncidentPackage | null> {
  const timeline = await getNotificationTimeline(notificationId);
  if (!timeline) return null;

  const notifRes = await admin
    .from("customer_notifications")
    .select("*")
    .eq("id", notificationId)
    .maybeSingle();
  const notif = (notifRes.data ?? {}) as Record<string, unknown>;

  const dispatchLog = await rows(admin, "notification_dispatch_log", (q) =>
    q
      .select("*")
      .eq("notification_id", notificationId)
      .order("created_at", { ascending: true })
  );

  // Provider webhook payloads matched by provider message id.
  const pmid =
    typeof notif.provider_message_id === "string"
      ? notif.provider_message_id
      : null;
  let webhookPayloads: unknown[] = [];
  if (pmid) {
    webhookPayloads = await rows(admin, "webhook_audit_log", (q) =>
      q
        .select("*")
        .ilike("event_id", `${pmid}%`)
        .order("created_at", { ascending: true })
    );
  }

  const commEvents = await rows(admin, "communication_events", (q) =>
    q
      .select("*")
      .eq("notification_id", notificationId)
      .order("created_at", { ascending: true })
  );

  return {
    kind: "notification",
    generatedAt: new Date().toISOString(),
    subject: `Notification ${notificationId} — ${timeline.channel ?? "?"} / ${timeline.kind ?? "?"}`,
    summary: {
      notificationId,
      channel: timeline.channel,
      kind: timeline.kind,
      finalStatus: timeline.status,
      attempts: notif.attempts ?? null,
      providerMessageId: pmid,
      errorReason: notif.error_reason ?? null,
    },
    timeline: timeline.events,
    records: {
      notification: [notif],
      dispatchLog,
      communicationEvents: commEvents,
      providerWebhookPayloads: webhookPayloads,
    },
  };
}

/** Build an alert-centric incident package. */
async function alertPackage(
  admin: Admin,
  alertEventId: string
): Promise<IncidentPackage | null> {
  const evRes = await admin
    .from("alert_events")
    .select("*")
    .eq("id", alertEventId)
    .maybeSingle();
  const ev = evRes.data as Record<string, unknown> | null;
  if (!ev) return null;

  // Escalation chain — every delivery attempt for the alert.
  const deliveries = await rows(admin, "alert_deliveries", (q) =>
    q
      .select("*")
      .eq("alert_event_id", alertEventId)
      .order("created_at", { ascending: true })
  );

  // Cron heartbeats around the incident window.
  const firstSeen =
    typeof ev.first_seen_at === "string" ? ev.first_seen_at : null;
  let heartbeats: unknown[] = [];
  if (firstSeen) {
    const windowStart = new Date(
      new Date(firstSeen).getTime() - 60 * 60 * 1000
    ).toISOString();
    heartbeats = await rows(admin, "cron_heartbeat_logs", (q) =>
      q
        .select("cron_name, started_at, success, error_message, rows_processed")
        .gte("started_at", windowStart)
        .order("started_at", { ascending: true })
        .limit(200)
    );
  }

  // Build a synthetic timeline from the alert lifecycle + deliveries.
  const timeline: Array<{ at: string; stage: string; detail: string }> = [];
  if (firstSeen) {
    timeline.push({
      at: firstSeen,
      stage: "fired",
      detail: `${ev.severity} — ${ev.rule_name}`,
    });
  }
  for (const d of deliveries as Array<Record<string, unknown>>) {
    timeline.push({
      at: String(d.created_at ?? ""),
      stage: d.kind === "escalation" ? "escalated" : "routed",
      detail: `${d.channel} → ${d.recipient ?? "—"} (${d.status})`,
    });
  }
  if (ev.acknowledged_at) {
    timeline.push({
      at: String(ev.acknowledged_at),
      stage: "acknowledged",
      detail: "operator acknowledged",
    });
  }
  if (ev.resolved_at) {
    timeline.push({
      at: String(ev.resolved_at),
      stage: "resolved",
      detail: `resolved (${ev.resolved_via ?? "?"})`,
    });
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));

  return {
    kind: "alert",
    generatedAt: new Date().toISOString(),
    subject: `Alert ${alertEventId} — ${ev.rule_name ?? "?"} (${ev.severity ?? "?"})`,
    summary: {
      alertEventId,
      ruleName: ev.rule_name,
      metric: ev.metric,
      severity: ev.severity,
      status: ev.status,
      branchId: ev.branch_id,
      occurrenceCount: ev.occurrence_count,
      escalationCount: ev.escalation_count,
      observed: ev.observed,
      threshold: ev.threshold,
    },
    timeline,
    records: {
      alertEvent: [ev],
      escalationChain: deliveries,
      cronHeartbeats: heartbeats,
    },
  };
}

export async function buildIncidentPackage(opts: {
  notificationId?: string;
  alertEventId?: string;
}): Promise<IncidentPackage | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  if (opts.notificationId) {
    return notificationPackage(admin, opts.notificationId);
  }
  if (opts.alertEventId) {
    return alertPackage(admin, opts.alertEventId);
  }
  return null;
}

/** Render an incident package as a human-readable markdown summary. */
export function incidentToMarkdown(pkg: IncidentPackage): string {
  const lines: string[] = [];
  lines.push(`# Incident snapshot — ${pkg.subject}`);
  lines.push("");
  lines.push(`- **Kind:** ${pkg.kind}`);
  lines.push(`- **Generated:** ${pkg.generatedAt}`);
  lines.push("");
  lines.push("## Summary");
  for (const [k, v] of Object.entries(pkg.summary)) {
    lines.push(`- **${k}:** ${v ?? "—"}`);
  }
  lines.push("");
  lines.push("## Timeline");
  if (pkg.timeline.length === 0) {
    lines.push("_(no timeline events)_");
  } else {
    for (const e of pkg.timeline as Array<Record<string, unknown>>) {
      lines.push(`- \`${e.at}\` **${e.stage}** — ${e.detail ?? ""}`);
    }
  }
  lines.push("");
  for (const [name, recs] of Object.entries(pkg.records)) {
    lines.push(`## ${name} (${recs.length})`);
    if (recs.length === 0) {
      lines.push("_(none)_");
    } else {
      lines.push("```json");
      lines.push(JSON.stringify(recs, null, 2));
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n");
}
