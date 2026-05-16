// Alert Events — persistence + delivery + lifecycle for fired alerts.
//
// communication_alert_rules (Phase 17) defines thresholds.
// lib/workerHealth.ts evaluates them. Phase 22 PERSISTED breaches into
// alert_events. Phase 23 DELIVERS them:
//
//   • recordAlertHits() — UPSERT one alert_events row per breach,
//     auto-resolve cleared rows, and:
//       - on a NEW breach: route to operator channels (per
//         alert_preferences) + record alert_deliveries rows.
//       - on a REPEAT breach still 'active' past the escalation
//         cooldown: re-route as an escalation.
//   • evaluateAndRecordAlerts() — compute health, then record.
//   • listAlertEvents / listAlertDeliveries — admin UI.
//   • acknowledgeAlert / resolveAlert — operator workflow.
//
// Delivery gating (severity floor + quiet hours) lives in
// lib/alertPreferences. Routing (email/Slack/LINE) lives in
// lib/alertRouting. This module orchestrates: gate → route → record.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { computeWorkerHealth, type AlertHit } from "@/lib/workerHealth";
import {
  routeAlert,
  type AlertRouteOutcome,
  type EscalationTier,
  type RoutableAlert,
} from "@/lib/alertRouting";
import { resolveAlertPreferences, shouldDeliver } from "@/lib/alertPreferences";
import { resolveEscalationContacts } from "@/lib/escalationRecipients";

/** A still-'active' alert re-routes at most once per this window. */
export const ESCALATION_COOLDOWN_MS = 2 * 60 * 60 * 1000;

export type AlertSource =
  | "worker-maintenance"
  | "cron-heartbeat"
  | "dispatch-worker"
  | "broadcast-worker"
  | "dead-letter-monitor"
  | "manual";

export type AlertEvent = {
  id: string;
  rule_id: string | null;
  rule_name: string;
  metric: string;
  severity: "warning" | "critical";
  source: AlertSource;
  branch_id: string | null;
  observed: number | null;
  threshold: number | null;
  comparison: "gt" | "lt" | null;
  status: "active" | "acknowledged" | "resolved";
  detail: Record<string, unknown>;
  occurrence_count: number;
  escalation_count: number;
  first_seen_at: string;
  last_seen_at: string;
  last_routed_at: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolved_via: "auto" | "operator" | null;
};

export type AlertDelivery = {
  id: string;
  alert_event_id: string | null;
  kind: "alert" | "escalation" | "digest";
  channel: "email" | "slack" | "line" | "console";
  recipient: string | null;
  status: "sent" | "delivered" | "failed" | "skipped";
  branch_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};

function sourceForMetric(metric: string): AlertSource {
  switch (metric) {
    case "cron_silence_minutes":
      return "cron-heartbeat";
    case "dead_letter_count":
      return "dead-letter-monitor";
    case "delivery_success_pct":
    case "queue_age_minutes":
    case "failure_count":
      return "dispatch-worker";
    default:
      return "worker-maintenance";
  }
}

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/**
 * Gate → route → record. Resolves the branch's alert preferences,
 * decides whether the alert should be pushed right now, routes it if
 * so, and writes one alert_deliveries row per channel outcome.
 *
 * Returns the routing outcomes (also stored on the event's detail).
 */
async function deliverAndRecord(
  admin: Admin,
  eventId: string,
  routable: RoutableAlert,
  kind: "alert" | "escalation",
  tier: EscalationTier
): Promise<AlertRouteOutcome[]> {
  const prefs = await resolveAlertPreferences(routable.branchId);
  const decision = shouldDeliver(prefs, routable.severity);

  if (!decision.deliver) {
    // Persist a single 'skipped' delivery so the history shows WHY
    // an alert wasn't pushed.
    await insertDeliveries(admin, eventId, kind, routable.branchId, [
      {
        channel: "email",
        recipient: null,
        status: "skipped",
        reason: decision.reason,
      },
    ]);
    return [];
  }

  // Phase 25: role-tiered escalation recipients widen the audience
  // as the alert climbs the chain. Merge them with the flat
  // alert_preferences.recipients[]; fall back to prefs alone when no
  // escalation_recipients row resolves.
  const esc = await resolveEscalationContacts({
    branchId: routable.branchId,
    severity: routable.severity,
    tier,
  });
  const recipients = Array.from(
    new Set([...esc.emails, ...prefs.recipients])
  );
  // Phase 26: fan out to every escalation LINE target + the
  // preference-scope target.
  const lineTargets = Array.from(
    new Set(
      [...esc.lineTargets, prefs.lineTarget ?? ""].filter(
        (t) => t.trim().length > 0
      )
    )
  );

  let outcomes: AlertRouteOutcome[] = [];
  try {
    outcomes = await routeAlert(routable, {
      recipients,
      lineTargets,
      tier,
    });
  } catch (err) {
    outcomes = [
      {
        channel: "email",
        recipient: null,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      },
    ];
  }
  await insertDeliveries(admin, eventId, kind, routable.branchId, outcomes);
  return outcomes;
}

async function insertDeliveries(
  admin: Admin,
  eventId: string,
  kind: "alert" | "escalation",
  branchId: string | null,
  outcomes: AlertRouteOutcome[]
): Promise<void> {
  if (outcomes.length === 0) return;
  try {
    await admin.from("alert_deliveries").insert(
      outcomes.map((o) => ({
        alert_event_id: eventId,
        kind,
        channel: o.channel,
        recipient: o.recipient,
        status: o.status,
        branch_id: branchId,
        provider_message_id: o.providerMessageId ?? null,
        detail: { reason: o.reason },
      }))
    );
  } catch (err) {
    console.warn(
      "[alert-events] delivery insert failed",
      err instanceof Error ? err.message : String(err)
    );
  }
}

export type RecordResult = {
  fired: number;
  repeated: number;
  escalated: number;
  autoResolved: number;
};

/**
 * Persist a set of currently-breaching alert rules.
 *
 *  • New breach  → insert 'active' row → deliver (per preferences).
 *  • Repeat breach, still 'active', last routed > 2h ago → escalate
 *    (re-route, bump escalation_count).
 *  • Repeat breach otherwise → bump counters only.
 *  • Rule with an open row but NOT in `hits` → auto-resolve.
 */
export async function recordAlertHits(opts: {
  hits: AlertHit[];
  source?: AlertSource;
}): Promise<RecordResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { fired: 0, repeated: 0, escalated: 0, autoResolved: 0 };
  }

  const result: RecordResult = {
    fired: 0,
    repeated: 0,
    escalated: 0,
    autoResolved: 0,
  };
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  const keyOf = (
    ruleId: string | null,
    branchId: string | null,
    metric: string
  ) => `${ruleId ?? ""}::${branchId ?? ""}::${metric}`;
  const breachingKeys = new Set(
    opts.hits.map((h) => keyOf(h.ruleId, h.branchId, h.metric))
  );

  for (const hit of opts.hits) {
    const source = opts.source ?? sourceForMetric(hit.metric);
    const routable: RoutableAlert = {
      ruleName: hit.ruleName,
      metric: hit.metric,
      severity: hit.severity,
      source,
      branchId: hit.branchId,
      observed: hit.observed,
      threshold: hit.threshold,
      comparison: hit.comparison,
    };

    // Existing open row?
    let q = admin
      .from("alert_events")
      .select("id, occurrence_count, escalation_count, status, last_routed_at")
      .eq("rule_id", hit.ruleId)
      .eq("metric", hit.metric)
      .in("status", ["active", "acknowledged"]);
    q = hit.branchId === null ? q.is("branch_id", null) : q.eq("branch_id", hit.branchId);
    const existing = await q.limit(1).maybeSingle();
    const row = existing.data as
      | {
          id: string;
          occurrence_count: number;
          escalation_count: number;
          status: string;
          last_routed_at: string | null;
        }
      | null;

    if (row) {
      // Repeat. Bump counters first.
      await admin
        .from("alert_events")
        .update({
          last_seen_at: nowIso,
          occurrence_count: (row.occurrence_count ?? 1) + 1,
          observed: hit.observed,
        })
        .eq("id", row.id);
      result.repeated += 1;

      // Escalate when STILL active (not acknowledged) and the last
      // route is older than the cooldown. Tier climbs the chain:
      // first escalation → HQ, every one after → owner.
      const lastRoutedMs = row.last_routed_at
        ? new Date(row.last_routed_at).getTime()
        : 0;
      if (
        row.status === "active" &&
        nowMs - lastRoutedMs > ESCALATION_COOLDOWN_MS
      ) {
        const tier: EscalationTier =
          (row.escalation_count ?? 0) === 0 ? "hq" : "owner";
        await deliverAndRecord(admin, row.id, routable, "escalation", tier);
        await admin
          .from("alert_events")
          .update({
            last_routed_at: nowIso,
            escalation_count: (row.escalation_count ?? 0) + 1,
          })
          .eq("id", row.id);
        result.escalated += 1;
      }
      continue;
    }

    // New breach — insert, then deliver.
    const ins = await admin
      .from("alert_events")
      .insert({
        rule_id: hit.ruleId,
        rule_name: hit.ruleName,
        metric: hit.metric,
        severity: hit.severity,
        source,
        branch_id: hit.branchId,
        observed: hit.observed,
        threshold: hit.threshold,
        comparison: hit.comparison,
        status: "active",
        detail: {},
        first_seen_at: nowIso,
        last_seen_at: nowIso,
        last_routed_at: nowIso,
      })
      .select("id")
      .single();
    if (ins.error || !ins.data) {
      // Unique-index race (another sweep beat us) — treat as repeat.
      result.repeated += 1;
      continue;
    }
    const eventId = (ins.data as { id: string }).id;
    const outcomes = await deliverAndRecord(
      admin,
      eventId,
      routable,
      "alert",
      "alert"
    );
    await admin
      .from("alert_events")
      .update({ detail: { routing: outcomes } })
      .eq("id", eventId);
    result.fired += 1;
  }

  // Auto-resolve rows whose rule no longer breaches.
  const openRes = await admin
    .from("alert_events")
    .select("id, rule_id, branch_id, metric")
    .in("status", ["active", "acknowledged"]);
  const openRows = (openRes.data ?? []) as Array<{
    id: string;
    rule_id: string | null;
    branch_id: string | null;
    metric: string;
  }>;
  for (const open of openRows) {
    const k = keyOf(open.rule_id, open.branch_id, open.metric);
    if (!breachingKeys.has(k)) {
      await admin
        .from("alert_events")
        .update({
          status: "resolved",
          resolved_at: nowIso,
          resolved_via: "auto",
        })
        .eq("id", open.id);
      result.autoResolved += 1;
    }
  }

  return result;
}

/**
 * Compute current worker health and persist + deliver any breaches.
 * Called by the worker-maintenance cron.
 */
export async function evaluateAndRecordAlerts(
  source: AlertSource = "worker-maintenance"
): Promise<RecordResult & { evaluated: number }> {
  const health = await computeWorkerHealth();
  const rec = await recordAlertHits({ hits: health.alerts, source });
  return { ...rec, evaluated: health.alerts.length };
}

// ---------- Admin UI helpers --------------------------------------------

export async function listAlertEvents(opts: {
  statuses?: Array<"active" | "acknowledged" | "resolved">;
  branchId?: string | null;
  limit?: number;
}): Promise<AlertEvent[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  let q = admin
    .from("alert_events")
    .select(
      "id, rule_id, rule_name, metric, severity, source, branch_id, observed, threshold, comparison, status, detail, occurrence_count, escalation_count, first_seen_at, last_seen_at, last_routed_at, acknowledged_at, resolved_at, resolved_via"
    )
    .order("last_seen_at", { ascending: false })
    .limit(Math.min(opts.limit ?? 100, 500));
  if (opts.statuses && opts.statuses.length > 0) {
    q = q.in("status", opts.statuses);
  }
  if (opts.branchId) {
    q = q.eq("branch_id", opts.branchId);
  }
  const res = await q;
  if (res.error || !res.data) return [];
  return res.data as AlertEvent[];
}

/**
 * Phase 26 replay tooling: re-route an existing alert event NOW,
 * regardless of the escalation cooldown. The tier is derived from
 * the event's escalation_count. Records fresh alert_deliveries rows.
 */
export async function replayAlertRouting(
  alertEventId: string
): Promise<{ ok: boolean; reason?: string; outcomes?: AlertRouteOutcome[] }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, reason: "no admin client" };
  const r = await admin
    .from("alert_events")
    .select(
      "id, rule_name, metric, severity, source, branch_id, observed, threshold, comparison, escalation_count"
    )
    .eq("id", alertEventId)
    .maybeSingle();
  const ev = r.data as
    | {
        id: string;
        rule_name: string;
        metric: string;
        severity: "warning" | "critical";
        source: AlertSource;
        branch_id: string | null;
        observed: number | null;
        threshold: number | null;
        comparison: "gt" | "lt" | null;
        escalation_count: number;
      }
    | null;
  if (!ev) return { ok: false, reason: "ไม่พบ alert event" };

  const tier: EscalationTier =
    (ev.escalation_count ?? 0) >= 2
      ? "owner"
      : (ev.escalation_count ?? 0) >= 1
        ? "hq"
        : "alert";
  const outcomes = await deliverAndRecord(
    admin,
    ev.id,
    {
      ruleName: ev.rule_name,
      metric: ev.metric,
      severity: ev.severity,
      source: ev.source,
      branchId: ev.branch_id,
      observed: ev.observed,
      threshold: ev.threshold,
      comparison: ev.comparison,
    },
    "escalation",
    tier
  );
  await admin
    .from("alert_events")
    .update({ last_routed_at: new Date().toISOString() })
    .eq("id", ev.id);
  return { ok: true, outcomes };
}

export async function listAlertDeliveries(opts: {
  branchId?: string | null;
  limit?: number;
}): Promise<AlertDelivery[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  let q = admin
    .from("alert_deliveries")
    .select(
      "id, alert_event_id, kind, channel, recipient, status, branch_id, detail, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(Math.min(opts.limit ?? 80, 300));
  if (opts.branchId) {
    q = q.eq("branch_id", opts.branchId);
  }
  const res = await q;
  if (res.error || !res.data) return [];
  return res.data as AlertDelivery[];
}

export async function acknowledgeAlert(
  id: string,
  actorId: string
): Promise<{ ok: boolean; reason?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, reason: "no admin client" };
  const upd = await admin
    .from("alert_events")
    .update({
      status: "acknowledged",
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: actorId,
    })
    .eq("id", id)
    .eq("status", "active");
  if (upd.error) return { ok: false, reason: upd.error.message };
  return { ok: true };
}

export async function resolveAlert(
  id: string,
  actorId: string
): Promise<{ ok: boolean; reason?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, reason: "no admin client" };
  const upd = await admin
    .from("alert_events")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by: actorId,
      resolved_via: "operator",
    })
    .eq("id", id)
    .in("status", ["active", "acknowledged"]);
  if (upd.error) return { ok: false, reason: upd.error.message };
  return { ok: true };
}
