"use client";

// /admin/crm/engagement — engagement intelligence dashboard.
//
// Reads /api/admin/crm/engagement and renders:
//   • Lifecycle breakdown KPI strip.
//   • 30-day retention trend (total + repeat).
//   • Churn risk count + top returning customers list.
//   • Trigger summary (24h per-kind fired/skipped/failed).
//   • Branch comparison stacked-bar (owner/HQ).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";

type ChannelPerf = {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
  avgLatencyMs: number | null;
  openRate: number | null;
  clickRate: number | null;
};

type Snapshot = {
  ok?: boolean;
  reason?: string;
  lifecycleBreakdown: Record<string, number>;
  retentionTrend: Array<{ date: string; repeat: number; total: number }>;
  churnRiskCount: number;
  topReturning: Array<{
    customerId: string;
    name: string | null;
    status: string;
    totalOrders: number;
    totalSpend: number;
    branchId: string | null;
  }>;
  triggerSummary: Record<
    string,
    { fired: number; skipped: number; failed: number }
  >;
  branchComparison: Array<{
    branchId: string;
    new: number;
    active: number;
    repeat: number;
    loyal: number;
    at_risk: number;
    dormant: number;
    churned: number;
  }>;
  campaignRoi?: {
    windowDays: number;
    attributedOrders: number;
    totalAttributedRevenue: number;
    recoveredDormantCount: number;
    avgResponseDays: number;
  };
  commsPerformance?: {
    windowDays: number;
    byChannel: Record<string, ChannelPerf>;
    avgLatencyMs: number | null;
  };
  generatedAt: string;
};

const STATUS_LABEL: Record<string, string> = {
  new: "ใหม่",
  active: "active",
  repeat: "ซ้ำ",
  loyal: "loyal",
  at_risk: "เสี่ยงหาย",
  dormant: "นอน",
  churned: "หายไป",
};

const STATUS_TONE: Record<string, string> = {
  new: "border-blue-200 bg-blue-50 text-blue-900",
  active: "border-emerald-200 bg-emerald-50 text-emerald-900",
  repeat: "border-green-200 bg-green-50 text-green-900",
  loyal: "border-amber-200 bg-amber-50 text-amber-900",
  at_risk: "border-orange-200 bg-orange-50 text-orange-900",
  dormant: "border-gray-200 bg-gray-50 text-gray-700",
  churned: "border-red-200 bg-red-50 text-red-900",
};

const TRIGGER_LABEL: Record<string, string> = {
  no_visit_x_days: "ไม่มาเกิน 60 วัน",
  pickup_overdue: "งานค้างรอรับ",
  inactive_vip: "VIP เงียบ",
  high_spend_dormant: "ลูกค้าใหญ่ dormant",
  birthday_month: "เดือนเกิด",
  first_time_followup: "ตามครั้งแรก",
};

export default function EngagementDashboardPage() {
  return (
    <RouteGuard page="admin">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/crm/engagement", {
        cache: "no-store",
      });
      const json = (await res.json()) as Snapshot;
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `โหลดล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <div className="p-8 text-gray-500">โหลด...</div>;
  if (error || !data) {
    return (
      <div className="p-8 max-w-md mx-auto">
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? "ไม่มีข้อมูล"}
        </div>
      </div>
    );
  }

  const totalCustomers = Object.values(data.lifecycleBreakdown).reduce(
    (a, b) => a + b,
    0
  );
  const repeatPct =
    totalCustomers > 0
      ? Math.round(
          ((data.lifecycleBreakdown.repeat + data.lifecycleBreakdown.loyal) /
            totalCustomers) *
            1000
        ) / 10
      : 0;
  const trendMax = Math.max(
    1,
    ...data.retentionTrend.map((p) => Math.max(p.total, p.repeat))
  );

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <Link href="/admin/crm/broadcasts" className="hover:text-green-700">
            CRM
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Engagement</span>
        </div>

        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">
            Engagement intelligence
          </h1>
          <p className="text-xs text-gray-500">
            อัปเดต {new Date(data.generatedAt).toLocaleString("th-TH")} ·
            ลูกค้าทั้งหมด {totalCustomers.toLocaleString()} ·{" "}
            <strong>{repeatPct}% เป็นลูกค้าซ้ำ/loyal</strong>
          </p>
        </div>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-bold text-gray-900">
            Lifecycle breakdown
          </h2>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
            {Object.entries(data.lifecycleBreakdown).map(([status, count]) => (
              <div
                key={status}
                className={`rounded-xl border px-3 py-2 ${STATUS_TONE[status] ?? STATUS_TONE.active}`}
              >
                <p className="text-[10px] uppercase tracking-widest font-semibold">
                  {STATUS_LABEL[status] ?? status}
                </p>
                <p className="mt-0.5 text-xl font-extrabold">
                  {count.toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        </section>

        <div className="grid lg:grid-cols-2 gap-5">
          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-bold text-gray-900">
              Retention trend (30 days)
            </h2>
            <p className="mt-1 text-[10px] text-gray-500">
              เทาเข้ม = total customers · เขียว = repeat customers
            </p>
            <div
              className="mt-3 flex items-end gap-0.5 h-32"
              style={{ minHeight: "8rem" }}
            >
              {data.retentionTrend.map((p) => {
                const totalH = (p.total / trendMax) * 100;
                const repeatH = (p.repeat / trendMax) * 100;
                return (
                  <div
                    key={p.date}
                    className="flex-1 flex flex-col-reverse"
                    title={`${p.date}: ${p.repeat} repeat / ${p.total} total`}
                  >
                    <div
                      className="bg-gray-300"
                      style={{ height: `${Math.max(totalH - repeatH, 0)}%` }}
                    />
                    <div
                      className="bg-green-500"
                      style={{ height: `${repeatH}%` }}
                    />
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-bold text-gray-900">
              Top returning customers
            </h2>
            {data.topReturning.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500">
                ยังไม่มีลูกค้าซ้ำ — รอข้อมูลจาก aggregator
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-gray-100">
                {data.topReturning.slice(0, 10).map((c) => (
                  <li
                    key={c.customerId}
                    className="py-2 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/admin/customers/${c.customerId}`}
                        className="text-sm font-semibold text-gray-900 hover:text-green-700"
                      >
                        {c.name ?? "(ไม่มีชื่อ)"}
                      </Link>
                      <div className="text-[10px] text-gray-500">
                        {c.totalOrders} ออเดอร์ · ฿
                        {Math.round(c.totalSpend).toLocaleString()} ·{" "}
                        {c.branchId ?? "—"}
                      </div>
                    </div>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_TONE[c.status] ?? STATUS_TONE.active}`}
                    >
                      {c.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {data.campaignRoi && (
          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-bold text-gray-900">
              Campaign ROI ({data.campaignRoi.windowDays}d)
            </h2>
            <p className="mt-1 text-[11px] text-gray-500">
              attributed orders + recovered dormant customers within
              attribution window
            </p>
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat
                label="ออเดอร์ attributed"
                value={data.campaignRoi.attributedOrders.toLocaleString()}
                tone="green"
              />
              <Stat
                label="รายได้ attributed"
                value={`฿${Math.round(data.campaignRoi.totalAttributedRevenue).toLocaleString()}`}
                tone="green"
              />
              <Stat
                label="ลูกค้า dormant ที่กลับมา"
                value={data.campaignRoi.recoveredDormantCount.toLocaleString()}
                tone="green"
              />
              <Stat
                label="avg response (วัน)"
                value={String(data.campaignRoi.avgResponseDays)}
              />
            </div>
          </section>
        )}

        {data.commsPerformance && (
          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-bold text-gray-900">
              Comms performance ({data.commsPerformance.windowDays}d)
            </h2>
            <p className="mt-1 text-[11px] text-gray-500">
              open + click + bounce + unsubscribe per channel · avg
              latency {data.commsPerformance.avgLatencyMs ?? "—"}ms
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-[10px] uppercase tracking-wider text-gray-600">
                  <tr>
                    <th className="px-3 py-2">Channel</th>
                    <th className="px-3 py-2">Sent</th>
                    <th className="px-3 py-2">Delivered</th>
                    <th className="px-3 py-2">Open %</th>
                    <th className="px-3 py-2">Click %</th>
                    <th className="px-3 py-2">Bounced</th>
                    <th className="px-3 py-2">Unsub</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {Object.entries(data.commsPerformance.byChannel).map(
                    ([ch, p]) => (
                      <tr key={ch} className="hover:bg-gray-50">
                        <td className="px-3 py-2 font-mono text-xs">
                          {ch.toUpperCase()}
                        </td>
                        <td className="px-3 py-2 text-xs">{p.sent}</td>
                        <td className="px-3 py-2 text-xs text-green-700">
                          {p.delivered}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {p.openRate == null ? "—" : `${p.openRate}%`}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {p.clickRate == null ? "—" : `${p.clickRate}%`}
                        </td>
                        <td className="px-3 py-2 text-xs text-red-700">
                          {p.bounced}
                        </td>
                        <td className="px-3 py-2 text-xs text-amber-700">
                          {p.unsubscribed}
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-bold text-gray-900">
            Retention triggers (24h)
          </h2>
          <div className="mt-3 grid sm:grid-cols-2 gap-2">
            {Object.entries(data.triggerSummary).map(([kind, s]) => (
              <div
                key={kind}
                className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-900">
                    {TRIGGER_LABEL[kind] ?? kind}
                  </span>
                  <span className="text-[10px] text-gray-500">{kind}</span>
                </div>
                <div className="mt-1 text-[11px] text-gray-700 space-x-2">
                  <span className="text-green-700">fired {s.fired}</span>
                  <span className="text-gray-500">skipped {s.skipped}</span>
                  <span className="text-red-700">failed {s.failed}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {data.branchComparison.length > 0 && (
          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-bold text-gray-900">
              Branch comparison
            </h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-[10px] uppercase tracking-wider text-gray-600">
                  <tr>
                    <th className="px-3 py-2">Branch</th>
                    <th className="px-3 py-2">new</th>
                    <th className="px-3 py-2">active</th>
                    <th className="px-3 py-2">repeat</th>
                    <th className="px-3 py-2">loyal</th>
                    <th className="px-3 py-2">at_risk</th>
                    <th className="px-3 py-2">dormant</th>
                    <th className="px-3 py-2">churned</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.branchComparison.map((b) => (
                    <tr key={b.branchId} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono text-xs">{b.branchId}</td>
                      <td className="px-3 py-2 text-xs">{b.new}</td>
                      <td className="px-3 py-2 text-xs">{b.active}</td>
                      <td className="px-3 py-2 text-xs text-green-700">{b.repeat}</td>
                      <td className="px-3 py-2 text-xs text-amber-700">{b.loyal}</td>
                      <td className="px-3 py-2 text-xs text-orange-700">{b.at_risk}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">{b.dormant}</td>
                      <td className="px-3 py-2 text-xs text-red-700">{b.churned}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "green" | "red" | "amber";
}) {
  const valueClass =
    tone === "green"
      ? "text-green-700"
      : tone === "red"
        ? "text-red-700"
        : tone === "amber"
          ? "text-amber-800"
          : "text-gray-900";
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
        {label}
      </p>
      <p className={`mt-0.5 text-lg font-extrabold ${valueClass}`}>{value}</p>
    </div>
  );
}
