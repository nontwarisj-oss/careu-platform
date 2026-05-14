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

type Snapshot = {
  generatedAt: string;
  overall: "healthy" | "warning" | "critical";
  crons: CronStatus[];
  queue: QueueHealth;
  alerts: AlertHit[];
};

const STATUS_TONE: Record<string, string> = {
  healthy: "border-green-200 bg-green-50 text-green-800",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  critical: "border-red-300 bg-red-100 text-red-900",
  unknown: "border-gray-200 bg-gray-50 text-gray-700",
};

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
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  usePortalRefresh(load, { intervalMs: 30_000, fireOnMount: false });

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

        {snapshot.alerts.length > 0 && (
          <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
            <h2 className="text-sm font-bold text-amber-900">
              Active alerts ({snapshot.alerts.length})
            </h2>
            <ul className="mt-2 space-y-1 text-xs">
              {snapshot.alerts.map((a) => (
                <li
                  key={a.ruleId}
                  className={`flex items-center justify-between gap-2 ${
                    a.severity === "critical"
                      ? "text-red-900"
                      : "text-amber-900"
                  }`}
                >
                  <span>
                    <strong>{a.ruleName}</strong> · {a.metric}{" "}
                    <code>
                      {a.observed} {a.comparison === "gt" ? ">" : "<"}{" "}
                      {a.threshold}
                    </code>
                    {a.branchId && (
                      <span className="ml-1 text-gray-700">
                        @{a.branchId}
                      </span>
                    )}
                  </span>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                      a.severity === "critical"
                        ? "border-red-300 bg-red-100 text-red-900"
                        : "border-amber-300 bg-amber-100 text-amber-900"
                    }`}
                  >
                    {a.severity}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

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
                  <th className="px-3 py-2">Last run</th>
                  <th className="px-3 py-2">Silent</th>
                  <th className="px-3 py-2">Streak</th>
                  <th className="px-3 py-2">Success (24h)</th>
                  <th className="px-3 py-2">Runs</th>
                  <th className="px-3 py-2">Last error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {snapshot.crons.map((c) => (
                  <tr key={c.cronName} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-xs">{c.cronName}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                          STATUS_TONE[c.status]
                        }`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-700">
                      {fmt(c.lastRunAt)}
                      {c.lastDurationMs != null && (
                        <span className="ml-1 text-[10px] text-gray-500">
                          ({c.lastDurationMs}ms)
                        </span>
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
                    <td className="px-3 py-2 text-xs text-gray-700">
                      {c.totalRuns24h}
                      {c.failedRuns24h > 0 && (
                        <span className="text-red-700">
                          {" "}
                          (×{c.failedRuns24h} failed)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-red-700 max-w-xs truncate">
                      {c.lastError ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
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
