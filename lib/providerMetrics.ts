// Provider Reliability Metrics — turns the raw dispatch + event logs
// into the numbers an operator uses to trust (or distrust) a channel
// provider.
//
// Sources (all read-only):
//   • notification_dispatch_log — per send ATTEMPT: outcome, provider,
//     attempt #, created_at.
//   • communication_events — provider + engagement events: delivered,
//     opened, clicked, bounced.
//   • webhook_audit_log — callback latency, when recorded.
//
// Per provider: success % / retry rate / bounce rate / click rate /
// callback latency / a coarse uptime estimate (fraction of hourly
// buckets with at least one successful send).
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { branches as ALL_BRANCHES } from "@/lib/brandConfig";

export type ProviderMetric = {
  provider: string;
  sends: number;
  failed: number;
  delivered: number;
  bounced: number;
  clicked: number;
  retried: number;
  successPct: number | null;
  retryRatePct: number | null;
  bounceRatePct: number | null;
  clickRatePct: number | null;
  avgCallbackLatencyMs: number | null;
  /** Fraction of hourly buckets in the window with ≥1 successful
   *  send, as a percentage. A coarse uptime proxy. */
  uptimeEstimatePct: number | null;
};

export type BranchDeliveryMetric = {
  branchId: string;
  branchLabel: string;
  sends: number;
  delivered: number;
  failed: number;
  successPct: number | null;
};

export type ProviderMetricsResult = {
  windowHours: number;
  generatedAt: string;
  byProvider: ProviderMetric[];
  byBranch: BranchDeliveryMetric[];
};

function pct(n: number, d: number): number | null {
  if (d <= 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

function branchLabel(code: string): string {
  const hit = ALL_BRANCHES.find(
    (b) => b.id === code || b.branchCode === code
  );
  return hit?.shortLabel ?? code;
}

export async function computeProviderMetrics(opts?: {
  windowHours?: number;
}): Promise<ProviderMetricsResult> {
  const windowHours = Math.max(1, Math.min(opts?.windowHours ?? 24, 24 * 30));
  const generatedAt = new Date().toISOString();
  const empty: ProviderMetricsResult = {
    windowHours,
    generatedAt,
    byProvider: [],
    byBranch: [],
  };
  const admin = getSupabaseAdmin();
  if (!admin) return empty;
  const since = new Date(
    Date.now() - windowHours * 60 * 60 * 1000
  ).toISOString();

  // ----- Per-provider, from the dispatch log -----
  const perProvider = new Map<
    string,
    {
      sends: number;
      failed: number;
      retried: number;
      hourBuckets: Set<string>;
    }
  >();
  try {
    const r = await admin
      .from("notification_dispatch_log")
      .select("provider, outcome, attempt, created_at")
      .gte("created_at", since)
      .limit(20000);
    const rows = (r.data ?? []) as Array<{
      provider: string | null;
      outcome: string;
      attempt: number | null;
      created_at: string;
    }>;
    for (const row of rows) {
      const provider = (row.provider ?? "unknown").toLowerCase();
      const p = (perProvider.get(provider) ?? {
        sends: 0,
        failed: 0,
        retried: 0,
        hourBuckets: new Set<string>(),
      }) as {
        sends: number;
        failed: number;
        retried: number;
        hourBuckets: Set<string>;
      };
      if (row.outcome === "sent") {
        p.sends += 1;
        p.hourBuckets.add(row.created_at.slice(0, 13)); // yyyy-mm-ddThh
      } else if (row.outcome === "failed") {
        p.failed += 1;
      }
      if ((row.attempt ?? 1) > 1) p.retried += 1;
      perProvider.set(provider, p);
    }
  } catch {
    // best-effort
  }

  // ----- delivered / bounced / clicked, from communication_events -----
  const perProviderEvents = new Map<
    string,
    { delivered: number; bounced: number; clicked: number }
  >();
  try {
    const r = await admin
      .from("communication_events")
      .select("provider, event_type")
      .gte("created_at", since)
      .limit(20000);
    const rows = (r.data ?? []) as Array<{
      provider: string | null;
      event_type: string;
    }>;
    for (const row of rows) {
      const provider = (row.provider ?? "unknown").toLowerCase();
      const e = (perProviderEvents.get(provider) ?? {
        delivered: 0,
        bounced: 0,
        clicked: 0,
      }) as { delivered: number; bounced: number; clicked: number };
      if (row.event_type === "delivered") e.delivered += 1;
      else if (row.event_type === "bounced" || row.event_type === "complained")
        e.bounced += 1;
      else if (row.event_type === "clicked") e.clicked += 1;
      perProviderEvents.set(provider, e);
    }
  } catch {
    // best-effort
  }

  // ----- callback latency, from webhook_audit_log -----
  const perProviderLatency = new Map<string, { sum: number; n: number }>();
  try {
    const r = await admin
      .from("webhook_audit_log")
      .select("provider, callback_latency_ms")
      .eq("outcome", "accepted")
      .gte("created_at", since)
      .not("callback_latency_ms", "is", null)
      .limit(20000);
    const rows = (r.data ?? []) as Array<{
      provider: string;
      callback_latency_ms: number | null;
    }>;
    for (const row of rows) {
      if (row.callback_latency_ms == null) continue;
      const l = perProviderLatency.get(row.provider) ?? { sum: 0, n: 0 };
      l.sum += row.callback_latency_ms;
      l.n += 1;
      perProviderLatency.set(row.provider, l);
    }
  } catch {
    // best-effort
  }

  const totalHourBuckets = Math.max(1, Math.ceil(windowHours));
  const providerNames = new Set([
    ...perProvider.keys(),
    ...perProviderEvents.keys(),
  ]);
  const byProvider: ProviderMetric[] = [];
  for (const name of providerNames) {
    const p = perProvider.get(name) ?? {
      sends: 0,
      failed: 0,
      retried: 0,
      hourBuckets: new Set<string>(),
    };
    const e = perProviderEvents.get(name) ?? {
      delivered: 0,
      bounced: 0,
      clicked: 0,
    };
    const lat = perProviderLatency.get(name);
    const total = p.sends + p.failed;
    byProvider.push({
      provider: name,
      sends: p.sends,
      failed: p.failed,
      delivered: e.delivered,
      bounced: e.bounced,
      clicked: e.clicked,
      retried: p.retried,
      successPct: pct(p.sends, total),
      retryRatePct: pct(p.retried, total),
      bounceRatePct: pct(e.bounced, p.sends),
      clickRatePct: pct(e.clicked, e.delivered),
      avgCallbackLatencyMs:
        lat && lat.n > 0 ? Math.round(lat.sum / lat.n) : null,
      uptimeEstimatePct: pct(p.hourBuckets.size, totalHourBuckets),
    });
  }
  byProvider.sort((a, b) => b.sends - a.sends);

  // ----- Per-branch delivery -----
  const byBranch: BranchDeliveryMetric[] = [];
  for (const b of ALL_BRANCHES) {
    try {
      const sentRes = await admin
        .from("customer_notifications")
        .select("id", { count: "exact", head: true })
        .in("status", ["sent", "delivered"])
        .eq("branch_id", b.id)
        .gte("created_at", since);
      const deliveredRes = await admin
        .from("customer_notifications")
        .select("id", { count: "exact", head: true })
        .eq("status", "delivered")
        .eq("branch_id", b.id)
        .gte("created_at", since);
      const failedRes = await admin
        .from("customer_notifications")
        .select("id", { count: "exact", head: true })
        .in("status", ["failed", "dead_letter"])
        .eq("branch_id", b.id)
        .gte("created_at", since);
      const sends = sentRes.count ?? 0;
      const delivered = deliveredRes.count ?? 0;
      const failed = failedRes.count ?? 0;
      byBranch.push({
        branchId: b.id,
        branchLabel: branchLabel(b.id),
        sends,
        delivered,
        failed,
        successPct: pct(sends, sends + failed),
      });
    } catch {
      // best-effort per branch
    }
  }

  return { windowHours, generatedAt, byProvider, byBranch };
}
