"use client";

// /admin/system/workers — worker telemetry dashboard.
//
// Owner / hq_admin only. Polls /api/admin/system/workers every 30s.
// Renders:
//   • Overall status banner (healthy / warning / critical).
//   • Per-cron rows with last run / silence / success rate.
//   • Queue health KPIs.
//   • Active alert hits.
//   • Self-heal button.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { usePortalRefresh } from "@/lib/usePortalRefresh";
import { cronEntry, isOverdue, nextExpectedRun } from "@/lib/cronManifest";

type CronStatus = {
  cronName: string;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastSuccess: boolean | null;
  lastError: string | null;
  silentForMinutes: number | null;
  expectedIntervalMinutes: number;
  successRate24h: number | null;
  totalRuns24h: number;
  failedRuns24h: number;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  status: "healthy" | "warning" | "critical" | "unknown";
};

type QueueHealth = {
  queuedTotal: number;
  sendingTotal: number;
  failedTotal: number;
  deadLetterTotal: number;
  oldestQueuedAt: string | null;
  oldestQueuedAgeMinutes: number | null;
  stuckSendingTotal: number;
};

type AlertHit = {
  ruleId: string;
  ruleName: string;
  metric: string;
  threshold: number;
  observed: number;
  comparison: "gt" | "lt";
  severity: "warning" | "critical";
  branchId: string | null;
};

type DriftFinding = {
  kind: "missing" | "orphan" | "stale" | "endpoint_mismatch";
  cronName: string;
  detail: string;
};

type ManifestDrift = {
  ok: boolean;
  manifestCount: number;
  vercelCount: number;
  findings: DriftFinding[];
};

type WebhookMetrics = {
  windowHours: number;
  total: number;
  accepted: number;
  invalidSignature: number;
  replay: number;
  malformed: number;
  error: number;
  acceptedPct: number | null;
};

type ProviderMetric = {
  provider: string;
  sends: number;
  failed: number;
  delivered: number;
  bounced: number;
  clicked: number;
  successPct: number | null;
  retryRatePct: number | null;
  bounceRatePct: number | null;
  clickRatePct: number | null;
  avgCallbackLatencyMs: number | null;
  uptimeEstimatePct: number | null;
};

type ProviderMetrics = {
  windowHours: number;
  byProvider: ProviderMetric[];
  byBranch: Array<{
    branchId: string;
    branchLabel: string;
    sends: number;
    delivered: number;
    failed: number;
    successPct: number | null;
  }>;
};

type RetryQueueMetrics = {
  windowHours: number;
  pending: number;
  retrying: number;
  deadLetter: number;
  succeeded24h: number;
};

type Snapshot = {
  generatedAt: string;
  overall: "healthy" | "warning" | "critical";
  crons: CronStatus[];
  queue: QueueHealth;
  alerts: AlertHit[];
  manifestDrift?: ManifestDrift;
  webhooks?: WebhookMetrics;
  providers?: ProviderMetrics;
  retryQueue?: RetryQueueMetrics;
};

type AlertEvent = {
  id: string;
  rule_name: string;
  metric: string;
  severity: "warning" | "critical";
  source: string;
  branch_id: string | null;
  observed: number | null;
  threshold: number | null;
  comparison: "gt" | "lt" | null;
  status: "active" | "acknowledged" | "resolved";
  occurrence_count: number;
  escalation_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_via: "auto" | "operator" | null;
};

type AlertDelivery = {
  id: string;
  alert_event_id: string | null;
  kind: "alert" | "escalation" | "digest";
  channel: "email" | "slack" | "line" | "console";
  recipient: string | null;
  status: "sent" | "delivered" | "failed" | "skipped";
  detail: Record<string, unknown>;
  created_at: string;
};

const STATUS_TONE: Record<string, string> = {
  healthy: "border-green-200 bg-green-50 text-green-800",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  critical: "border-red-300 bg-red-100 text-red-900",
  unknown: "border-gray-200 bg-gray-50 text-gray-700",
};

/** A one-line "what to do" hint for a cron row, based on its state. */
function recoveryHint(c: CronStatus): string {
  if (c.status === "healthy") return "—";
  if (c.consecutiveFailures >= 3) {
    return "check last error · fix root cause · Run maintenance";
  }
  if (c.consecutiveFailures >= 1) return "transient fail · watch next tick";
  if (c.status === "critical") {
    return "cron silent · verify scheduler + run /api/cron route";
  }
  if (c.status === "warning") return "running slow · watch for escalation";
  if (c.status === "unknown") return "no heartbeat yet · verify schedule";
  return "—";
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("th-TH", {
      dateStyle: "short",
      timeStyle: "medium",
    });
  } catch {
    return iso;
  }
}

export default function WorkersDashboardPage() {
  return (
    <RouteGuard page="admin">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [alertEvents, setAlertEvents] = useState<AlertEvent[]>([]);
  const [deliveries, setDeliveries] = useState<AlertDelivery[]>([]);
  const [alertBusy, setAlertBusy] = useState(false);

  const loadAlerts = useCallback(async () => {
    try {
      const res = await fetch(
        "/api/admin/system/alerts?status=active,acknowledged",
        { cache: "no-store" }
      );
      const json = (await res.json()) as {
        ok?: boolean;
        events?: AlertEvent[];
      };
      if (json.ok) setAlertEvents(json.events ?? []);
    } catch {
      // best-effort — the worker snapshot is the primary surface
    }
    try {
      const res = await fetch("/api/admin/system/alerts?view=deliveries", {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        deliveries?: AlertDelivery[];
      };
      if (json.ok) setDeliveries(json.deliveries ?? []);
    } catch {
      // best-effort
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/system/workers", {
        cache: "no-store",
      });
      const json = (await res.json()) as Snapshot & {
        ok?: boolean;
        reason?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `โหลดล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setSnapshot(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
    void loadAlerts();
  }, [loadAlerts]);

  useEffect(() => {
    void load();
  }, [load]);
  usePortalRefresh(load, { intervalMs: 30_000, fireOnMount: false });

  const handleAlertAction = async (
    id: string,
    action: "acknowledge" | "resolve"
  ) => {
    setAlertBusy(true);
    try {
      const res = await fetch("/api/admin/system/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!json.ok) {
        window.alert(json.reason ?? `${action} ล้มเหลว`);
      }
      await loadAlerts();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Network error");
    } finally {
      setAlertBusy(false);
    }
  };

  const handleRunMaintenance = async () => {
    if (!window.confirm("Run maintenance sweep? ล้าง stale locks + ประเมิน alert rules"))
      return;
    setAlertBusy(true);
    try {
      const res = await fetch("/api/admin/system/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run-maintenance" }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        janitor?: { released?: number };
        alerts?: { fired?: number; autoResolved?: number };
      };
      if (!json.ok) {
        window.alert(json.reason ?? "maintenance ล้มเหลว");
      } else {
        window.alert(
          `Maintenance เสร็จ — locks ปลด ${json.janitor?.released ?? 0} · alerts ใหม่ ${json.alerts?.fired ?? 0} · auto-resolved ${json.alerts?.autoResolved ?? 0}`
        );
      }
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Network error");
    } finally {
      setAlertBusy(false);
    }
  };

  const handleSendDigest = async () => {
    if (
      !window.confirm(
        "ส่ง operator digest ตอนนี้? จะส่ง email ไปยัง recipients ที่เปิด digest"
      )
    )
      return;
    setAlertBusy(true);
    try {
      const res = await fetch("/api/admin/system/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send-digest" }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        digest?: { recipients?: number; sent?: number; failed?: number };
      };
      if (!json.ok) {
        window.alert(json.reason ?? "digest ล้มเหลว");
      } else {
        window.alert(
          `Digest — recipients ${json.digest?.recipients ?? 0} · sent ${json.digest?.sent ?? 0} · failed ${json.digest?.failed ?? 0}`
        );
      }
      await loadAlerts();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Network error");
    } finally {
      setAlertBusy(false);
    }
  };

  const handleRecover = async () => {
    if (!window.confirm("Run self-heal? จะปลดล็อก stuck rows + log audit row")) {
      return;
    }
    setRecovering(true);
    try {
      const res = await fetch("/api/admin/system/recover-workers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        actions?: Array<{ action: string; rowsAffected: number }>;
        reason?: string;
      };
      if (!res.ok || !json.ok) {
        window.alert(`self-heal ล้มเหลว: ${json.reason ?? `HTTP ${res.status}`}`);
      } else {
        const summary = (json.actions ?? [])
          .map((a) => `${a.action}: ${a.rowsAffected}`)
          .join(" · ");
        window.alert(`self-heal เสร็จ — ${summary}`);
        await load();
      }
    } catch (err) {
      window.alert(
        `self-heal ล้มเหลว: ${err instanceof Error ? err.message : "Network error"}`
      );
    } finally {
      setRecovering(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-gray-500">โหลด...</div>;
  }
  if (error || !snapshot) {
    return (
      <div className="p-8 max-w-md mx-auto">
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? "โหลดล้มเหลว"}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">System · Workers</span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold text-gray-900">
              Worker telemetry
            </h1>
            <p className="text-xs text-gray-500">
              อัปเดต {fmt(snapshot.generatedAt)} · รีเฟรชอัตโนมัติทุก 30 วินาที
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wider ${
                STATUS_TONE[snapshot.overall]
              }`}
            >
              {snapshot.overall}
            </span>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700"
            >
              รีเฟรช
            </button>
            <Link
              href="/admin/system/alert-preferences"
              className="rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700"
            >
              Alert prefs
            </Link>
            <button
              type="button"
              onClick={() => void handleSendDigest()}
              disabled={alertBusy}
              className="rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700 disabled:opacity-50"
            >
              Send digest
            </button>
            <button
              type="button"
              onClick={() => void handleRunMaintenance()}
              disabled={alertBusy}
              className="rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700 disabled:opacity-50"
            >
              Run maintenance
            </button>
            <button
              type="button"
              onClick={() => void handleRecover()}
              disabled={recovering}
              className="rounded-xl bg-red-700 hover:bg-red-800 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50"
            >
              {recovering ? "กำลัง self-heal..." : "Self-heal"}
            </button>
          </div>
        </div>

        <AlertEventsSection
          events={alertEvents}
          busy={alertBusy}
          onAction={handleAlertAction}
        />

        <AlertHistorySection deliveries={deliveries} />

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-bold text-gray-900">Queue health</h2>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <KPI label="Queued" value={snapshot.queue.queuedTotal} />
            <KPI label="Sending" value={snapshot.queue.sendingTotal} />
            <KPI
              label="Failed (retrying)"
              value={snapshot.queue.failedTotal}
              tone={snapshot.queue.failedTotal > 0 ? "amber" : undefined}
            />
            <KPI
              label="Dead-letter"
              value={snapshot.queue.deadLetterTotal}
              tone={snapshot.queue.deadLetterTotal > 0 ? "red" : undefined}
            />
            <KPI
              label="Oldest queued (min)"
              value={snapshot.queue.oldestQueuedAgeMinutes ?? 0}
              tone={
                (snapshot.queue.oldestQueuedAgeMinutes ?? 0) > 10
                  ? "red"
                  : (snapshot.queue.oldestQueuedAgeMinutes ?? 0) > 5
                    ? "amber"
                    : undefined
              }
            />
            <KPI
              label="Stuck sending"
              value={snapshot.queue.stuckSendingTotal}
              tone={snapshot.queue.stuckSendingTotal > 0 ? "red" : undefined}
            />
          </div>
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white">
          <div className="p-4 border-b border-gray-100">
            <h2 className="text-base font-bold text-gray-900">Cron status</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-[10px] uppercase tracking-wider text-gray-600">
                <tr>
                  <th className="px-3 py-2">Cron</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Schedule</th>
                  <th className="px-3 py-2">Last run</th>
                  <th className="px-3 py-2">Next expected</th>
                  <th className="px-3 py-2">Silent</th>
                  <th className="px-3 py-2">Streak</th>
                  <th className="px-3 py-2">Success (24h)</th>
                  <th className="px-3 py-2">Recovery</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {snapshot.crons.map((c) => {
                  const entry = cronEntry(c.cronName);
                  const nextRun = nextExpectedRun(
                    c.lastRunAt,
                    c.expectedIntervalMinutes
                  );
                  const overdue = isOverdue(
                    c.lastRunAt,
                    c.expectedIntervalMinutes
                  );
                  const recovery = recoveryHint(c);
                  return (
                    <tr key={c.cronName} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono text-xs">
                        {c.cronName}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                            STATUS_TONE[c.status]
                          }`}
                        >
                          {c.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[10px] font-mono text-gray-600">
                        {entry?.schedule ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-700">
                        {fmt(c.lastRunAt)}
                        {c.lastDurationMs != null && (
                          <span className="ml-1 text-[10px] text-gray-500">
                            ({c.lastDurationMs}ms)
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 text-xs ${
                          overdue ? "text-red-700 font-semibold" : "text-gray-700"
                        }`}
                      >
                        {nextRun ? fmt(nextRun) : "—"}
                        {overdue && (
                          <span className="ml-1 text-[10px]">missed</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {c.silentForMinutes != null
                          ? `${c.silentForMinutes}m / ${c.expectedIntervalMinutes}m`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {c.consecutiveFailures > 0 ? (
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                              c.consecutiveFailures >= 3
                                ? "border-red-300 bg-red-50 text-red-800"
                                : "border-amber-300 bg-amber-50 text-amber-800"
                            }`}
                            title={c.lastFailureMessage ?? undefined}
                          >
                            ×{c.consecutiveFailures}
                          </span>
                        ) : (
                          <span className="text-[10px] text-gray-400">—</span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 text-xs ${
                          c.successRate24h != null && c.successRate24h < 80
                            ? "text-red-700"
                            : "text-gray-700"
                        }`}
                      >
                        {c.successRate24h != null
                          ? `${c.successRate24h}%`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-[10px] text-gray-600 max-w-[22ch]">
                        {recovery}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {snapshot.manifestDrift && (
          <ManifestDriftSection drift={snapshot.manifestDrift} />
        )}
        {snapshot.providers && (
          <ProviderMetricsSection providers={snapshot.providers} />
        )}
        {snapshot.webhooks && (
          <WebhookTrustSection webhooks={snapshot.webhooks} />
        )}
        {snapshot.retryQueue && (
          <RetryQueueSection retry={snapshot.retryQueue} />
        )}
      </div>
    </div>
  );
}

function RetryQueueSection({ retry }: { retry: RetryQueueMetrics }) {
  const open = retry.pending + retry.retrying;
  return (
    <section
      className={`rounded-2xl border p-4 ${
        retry.deadLetter > 0
          ? "border-red-300 bg-red-50"
          : open > 0
            ? "border-amber-300 bg-amber-50"
            : "border-gray-200 bg-white"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-gray-900">
          Webhook reliability ({retry.windowHours}h)
        </h2>
        <Link
          href="/admin/system/webhook-retries"
          className="text-[11px] font-semibold text-green-700 hover:text-green-900 underline"
        >
          เปิด retry / dead-letter explorer →
        </Link>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
        <Chip label="pending" value={retry.pending} tone={retry.pending > 0 ? "amber" : "gray"} />
        <Chip label="retrying" value={retry.retrying} tone={retry.retrying > 0 ? "amber" : "gray"} />
        <Chip
          label="dead-letter"
          value={retry.deadLetter}
          tone={retry.deadLetter > 0 ? "red" : "gray"}
        />
        <Chip label="recovered 24h" value={retry.succeeded24h} tone="green" />
      </div>
      {retry.deadLetter > 0 && (
        <p className="mt-2 text-[11px] text-red-800">
          ⚠ มี webhook {retry.deadLetter} รายการใน dead-letter — ต้อง replay
          ด้วยตนเองหรือตรวจสอบ
        </p>
      )}
    </section>
  );
}

function ManifestDriftSection({ drift }: { drift: ManifestDrift }) {
  return (
    <section
      className={`rounded-2xl border p-4 ${
        drift.ok
          ? "border-green-200 bg-green-50"
          : "border-red-300 bg-red-50"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-gray-900">
          Cron manifest drift
        </h2>
        <span className="text-[10px] text-gray-500">
          manifest {drift.manifestCount} · vercel.json {drift.vercelCount}
        </span>
      </div>
      {drift.ok ? (
        <p className="mt-1 text-xs text-green-800">
          ✓ manifest, vercel.json และ heartbeat ตรงกันทั้งหมด
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {drift.findings.map((f, i) => (
            <li key={`${f.cronName}-${i}`} className="text-xs text-red-900">
              <span className="rounded-full border border-red-300 bg-red-100 px-1.5 py-0.5 text-[9px] font-bold uppercase">
                {f.kind}
              </span>{" "}
              <code className="font-mono">{f.cronName}</code> — {f.detail}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProviderMetricsSection({
  providers,
}: {
  providers: ProviderMetrics;
}) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white">
      <div className="p-4 border-b border-gray-100">
        <h2 className="text-base font-bold text-gray-900">
          Provider reliability ({providers.windowHours}h)
        </h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-[10px] uppercase tracking-wider text-gray-600">
            <tr>
              <th className="px-3 py-2">Provider</th>
              <th className="px-3 py-2">Sends</th>
              <th className="px-3 py-2">Success</th>
              <th className="px-3 py-2">Retry</th>
              <th className="px-3 py-2">Bounce</th>
              <th className="px-3 py-2">Click</th>
              <th className="px-3 py-2">Callback latency</th>
              <th className="px-3 py-2">Uptime est.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {providers.byProvider.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-xs text-gray-500">
                  ยังไม่มีกิจกรรมในช่วงนี้
                </td>
              </tr>
            ) : (
              providers.byProvider.map((p) => (
                <tr key={p.provider} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs">{p.provider}</td>
                  <td className="px-3 py-2 text-xs text-gray-700">{p.sends}</td>
                  <td
                    className={`px-3 py-2 text-xs ${
                      p.successPct != null && p.successPct < 90
                        ? "text-red-700 font-semibold"
                        : "text-gray-700"
                    }`}
                  >
                    {p.successPct != null ? `${p.successPct}%` : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700">
                    {p.retryRatePct != null ? `${p.retryRatePct}%` : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700">
                    {p.bounceRatePct != null ? `${p.bounceRatePct}%` : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700">
                    {p.clickRatePct != null ? `${p.clickRatePct}%` : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700">
                    {p.avgCallbackLatencyMs != null
                      ? `${p.avgCallbackLatencyMs}ms`
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700">
                    {p.uptimeEstimatePct != null
                      ? `${p.uptimeEstimatePct}%`
                      : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {providers.byBranch.length > 0 && (
        <div className="border-t border-gray-100 p-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            By branch
          </p>
          <div className="flex flex-wrap gap-2">
            {providers.byBranch.map((b) => (
              <span
                key={b.branchId}
                className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-700"
              >
                {b.branchLabel}: {b.sends} sends ·{" "}
                {b.successPct != null ? `${b.successPct}%` : "—"} ok
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function WebhookTrustSection({
  webhooks,
}: {
  webhooks: WebhookMetrics;
}) {
  const bad = webhooks.invalidSignature + webhooks.malformed + webhooks.error;
  return (
    <section
      className={`rounded-2xl border p-4 ${
        bad > 0 ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-white"
      }`}
    >
      <h2 className="text-sm font-bold text-gray-900">
        Webhook trust ({webhooks.windowHours}h)
      </h2>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
        <Chip label="accepted" value={webhooks.accepted} tone="green" />
        <Chip label="replay (benign)" value={webhooks.replay} tone="gray" />
        <Chip
          label="invalid signature"
          value={webhooks.invalidSignature}
          tone={webhooks.invalidSignature > 0 ? "red" : "gray"}
        />
        <Chip
          label="malformed"
          value={webhooks.malformed}
          tone={webhooks.malformed > 0 ? "red" : "gray"}
        />
        <Chip
          label="handler error"
          value={webhooks.error}
          tone={webhooks.error > 0 ? "red" : "gray"}
        />
      </div>
    </section>
  );
}

function Chip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "green" | "red" | "gray" | "amber";
}) {
  const cls =
    tone === "green"
      ? "border-green-300 bg-green-50 text-green-800"
      : tone === "red"
        ? "border-red-300 bg-red-50 text-red-800"
        : tone === "amber"
          ? "border-amber-300 bg-amber-50 text-amber-800"
          : "border-gray-300 bg-gray-50 text-gray-600";
  return (
    <span className={`rounded-full border px-2 py-0.5 font-semibold ${cls}`}>
      {label} {value}
    </span>
  );
}

function AlertEventsSection({
  events,
  busy,
  onAction,
}: {
  events: AlertEvent[];
  busy: boolean;
  onAction: (id: string, action: "acknowledge" | "resolve") => void;
}) {
  if (events.length === 0) {
    return (
      <section className="rounded-2xl border border-green-200 bg-green-50 px-4 py-3">
        <p className="text-xs font-semibold text-green-800">
          ✓ ไม่มี alert ที่ยัง active — worker health ปกติ
        </p>
      </section>
    );
  }
  const activeCount = events.filter((e) => e.status === "active").length;
  return (
    <section className="rounded-2xl border border-amber-300 bg-amber-50">
      <div className="p-4 border-b border-amber-200">
        <h2 className="text-sm font-bold text-amber-900">
          Active alerts ({events.length}) · {activeCount} unacknowledged
        </h2>
        <p className="text-[10px] text-amber-800">
          ประเมินทุก ~15 นาทีโดย worker-maintenance cron · auto-resolve เมื่อ rule
          หายจาก breach
        </p>
      </div>
      <ul className="divide-y divide-amber-200">
        {events.map((e) => (
          <li key={e.id} className="px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                      e.severity === "critical"
                        ? "border-red-300 bg-red-100 text-red-900"
                        : "border-amber-300 bg-amber-100 text-amber-900"
                    }`}
                  >
                    {e.severity}
                  </span>
                  <span className="text-sm font-semibold text-gray-900 truncate">
                    {e.rule_name}
                  </span>
                  {e.status === "acknowledged" && (
                    <span className="rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-800">
                      acknowledged
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-gray-700">
                  <code>
                    {e.metric} = {e.observed ?? "?"}{" "}
                    {e.comparison === "gt" ? ">" : "<"} {e.threshold ?? "?"}
                  </code>
                  <span className="ml-2 text-gray-500">
                    source: {e.source}
                    {e.branch_id && ` · @${e.branch_id}`}
                    {e.occurrence_count > 1 && ` · ×${e.occurrence_count}`}
                    {e.escalation_count > 0 &&
                      ` · escalated ×${e.escalation_count}`}
                  </span>
                </div>
                <div className="mt-0.5 text-[10px] text-gray-500">
                  first {fmt(e.first_seen_at)} · last {fmt(e.last_seen_at)}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                {e.status === "active" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAction(e.id, "acknowledge")}
                    className="rounded-md border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-800 px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
                  >
                    Acknowledge
                  </button>
                )}
                <a
                  href={`/api/admin/system/incident-export?alertEventId=${e.id}&format=md`}
                  className="rounded-md border border-gray-200 bg-gray-50 hover:bg-gray-100 text-gray-700 px-2 py-1 text-[11px] font-semibold"
                  title="ดาวน์โหลด incident snapshot (markdown)"
                >
                  Export
                </a>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onAction(e.id, "resolve")}
                  className="rounded-md border border-green-200 bg-green-50 hover:bg-green-100 text-green-800 px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
                >
                  Resolve
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const DELIVERY_TONE: Record<string, string> = {
  sent: "border-green-300 bg-green-50 text-green-800",
  delivered: "border-green-300 bg-green-50 text-green-800",
  failed: "border-red-300 bg-red-50 text-red-800",
  skipped: "border-gray-300 bg-gray-50 text-gray-600",
};

function AlertHistorySection({ deliveries }: { deliveries: AlertDelivery[] }) {
  const counts = deliveries.reduce(
    (acc, d) => {
      acc[d.status] = (acc[d.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );
  return (
    <section className="rounded-2xl border border-gray-200 bg-white">
      <div className="p-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900">
            Alert delivery history
          </h2>
          <p className="text-[10px] text-gray-500">
            อีเมล / Slack / digest ที่ routing layer ส่งออก — ล่าสุด 120 รายการ
          </p>
        </div>
        <div className="flex gap-1 text-[10px]">
          {(["sent", "delivered", "failed", "skipped"] as const).map((s) => (
            <span
              key={s}
              className={`rounded-full border px-2 py-0.5 font-semibold ${DELIVERY_TONE[s]}`}
            >
              {s} {counts[s] ?? 0}
            </span>
          ))}
        </div>
      </div>
      {deliveries.length === 0 ? (
        <p className="px-4 py-6 text-sm text-gray-500 text-center">
          ยังไม่มีประวัติการส่ง
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-[10px] uppercase tracking-wider text-gray-600">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Channel</th>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {deliveries.slice(0, 60).map((d) => (
                <tr key={d.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap">
                    {fmt(d.created_at)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                        d.kind === "escalation"
                          ? "border-amber-300 bg-amber-50 text-amber-800"
                          : d.kind === "digest"
                            ? "border-blue-300 bg-blue-50 text-blue-800"
                            : "border-gray-200 bg-gray-50 text-gray-700"
                      }`}
                    >
                      {d.kind}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700">
                    {d.channel}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700 max-w-[16ch] truncate">
                    {d.recipient ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                        DELIVERY_TONE[d.status] ?? DELIVERY_TONE.skipped
                      }`}
                    >
                      {d.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[10px] text-gray-500 max-w-xs truncate">
                    {typeof d.detail?.reason === "string"
                      ? d.detail.reason
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function KPI({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "amber" | "red";
}) {
  const valueClass =
    tone === "red"
      ? "text-red-700"
      : tone === "amber"
        ? "text-amber-800"
        : "text-gray-900";
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
        {label}
      </p>
      <p className={`mt-0.5 text-lg font-extrabold ${valueClass}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}
