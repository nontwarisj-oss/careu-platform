// Alert Events — persistence + lifecycle for fired alert rules.
//
// communication_alert_rules (Phase 17) defines thresholds.
// lib/workerHealth.ts evaluates them in-memory on demand. Until
// Phase 22 nothing PERSISTED a breach, so an alert that fired and
// cleared between two dashboard visits was simply never seen.
//
// This module closes that gap:
//   • recordAlertHits()  — UPSERT one alert_events row per breach,
//     auto-resolve rows whose rule stopped breaching, route NEW
//     alerts to operator channels.
//   • evaluateAndRecordAlerts() — convenience: compute health, then
//     record. Called by the worker-maintenance cron.
//   • listAlertEvents / acknowledgeAlert / resolveAlert — admin UI.
//
// Dedup: at most one open ('active' | 'acknowledged') row per
// (rule_id, branch_id, metric) — enforced by a partial unique index
// AND by the read-before-write here. The worker-maintenance cron
// holds a worker_lock so two sweeps never race.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { computeWorkerHealth, type AlertHit } from "@/lib/workerHealth";
import { routeAlert, type RoutableAlert } from "@/lib/alertRouting";

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
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolved_via: "auto" | "operator" | null;
};

/** Map an alert metric to the worker most responsible for it — used
 *  for the `source` column so the operator sees "where" at a glance. */
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

export type RecordResult = {
  fired: number;
  repeated: number;
  autoResolved: number;
};

/**
 * Persist a set of currently-breaching alert rules.
 *
 *  • New breach  → insert an 'active' row + route it to operator
 *    channels (Slack / email / LINE per env).
 *  • Repeat breach → bump last_seen_at + occurrence_count (no route).
 *  • A rule that has an open row but is NOT in `hits` → auto-resolve.
 */
export async function recordAlertHits(opts: {
  hits: AlertHit[];
  source?: AlertSource;
}): Promise<RecordResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { fired: 0, repeated: 0, autoResolved: 0 };

  const result: RecordResult = { fired: 0, repeated: 0, autoResolved: 0 };
  const nowIso = new Date().toISOString();

  // Key helper — must match the partial unique index expression.
  const keyOf = (ruleId: string | null, branchId: string | null, metric: string) =>
    `${ruleId ?? ""}::${branchId ?? ""}::${metric}`;
  const breachingKeys = new Set(
    opts.hits.map((h) => keyOf(h.ruleId, h.branchId, h.metric))
  );

  // ----- 1. Upsert each breach -----
  for (const hit of opts.hits) {
    const source = opts.source ?? sourceForMetric(hit.metric);
    // Existing open row?
    let q = admin
      .from("alert_events")
      .select("id, occurrence_count, status")
      .eq("rule_id", hit.ruleId)
      .eq("metric", hit.metric)
      .in("status", ["active", "acknowledged"]);
    q = hit.branchId === null ? q.is("branch_id", null) : q.eq("branch_id", hit.branchId);
    const existing = await q.limit(1).maybeSingle();
    const row = existing.data as
      | { id: string; occurrence_count: number; status: string }
      | null;

    if (row) {
      // Repeat — bump counters, leave status (keep 'acknowledged').
      await admin
        .from("alert_events")
        .update({
          last_seen_at: nowIso,
          occurrence_count: (row.occurrence_count ?? 1) + 1,
          observed: hit.observed,
        })
        .eq("id", row.id);
      result.repeated += 1;
      continue;
    }

    // New breach — route first so the routing outcome lands on the row.
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
    let routing: unknown[] = [];
    try {
      routing = await routeAlert(routable);
    } catch {
      routing = [];
    }
    const ins = await admin.from("alert_events").insert({
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
      detail: { routing },
      first_seen_at: nowIso,
      last_seen_at: nowIso,
    });
    if (!ins.error) {
      result.fired += 1;
    } else {
      // Unique-index race (another sweep beat us) — treat as repeat.
      result.repeated += 1;
    }
  }

  // ----- 2. Auto-resolve rows whose rule no longer breaches -----
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
 * Compute current worker health and persist any alert breaches.
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
      "id, rule_id, rule_name, metric, severity, source, branch_id, observed, threshold, comparison, status, detail, occurrence_count, first_seen_at, last_seen_at, acknowledged_at, resolved_at, resolved_via"
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
