"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/lib/languageContext";
import { useBranch } from "@/lib/branchContext";
import { useRole } from "@/lib/roleContext";
import { BrandLogo } from "@/components/BrandLogo";
import { type AnalyticsOrder, filterByBranch } from "@/lib/analytics";
import type { ExpenseRow } from "@/lib/expenses";
import {
  fetchDashboardSnapshot,
  type DashboardSnapshot,
} from "@/lib/dashboardData";
import {
  DASHBOARD_LABELS,
  getAccessibleDashboards,
  getDefaultDashboard,
  seesAllBranches,
  type DashboardKey,
} from "@/lib/roles";
import { FrontDeskDashboard } from "@/components/dashboard/FrontDeskDashboard";
import { ProductionDashboard } from "@/components/dashboard/ProductionDashboard";
import { AccountingDashboard } from "@/components/dashboard/AccountingDashboard";
import { ManagerDashboard } from "@/components/dashboard/ManagerDashboard";
import { ExecutiveDashboard } from "@/components/dashboard/ExecutiveDashboard";
import type { DailySnapshotRow } from "@/lib/aggregationService";
import {
  assembleSnapshotKpis,
  type SnapshotKpiBundle,
} from "@/lib/dashboardSnapshotKpi";

export default function Dashboard() {
  const { language } = useLanguage();
  const { branch } = useBranch();
  const { role, definition } = useRole();

  // The fetcher returns ALL data (branch-filtered for branch-locked roles).
  // The page keeps the role-tab logic + passes the appropriate slice to each
  // dashboard component. Data layer lives in lib/dashboardData.ts so future
  // pages can reuse the same fetcher without re-implementing.
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeDashboard, setActiveDashboard] = useState<DashboardKey>(
    getDefaultDashboard(role)
  );
  // Snapshot-backed summary metadata. Optional — when present we surface
  // a "data as of" indicator. Falls back to a live read on the server
  // when the matview is empty (fresh deploy / first refresh pending).
  const [snapshotMeta, setSnapshotMeta] = useState<{
    usingSnapshot: boolean;
    snapshotRefreshedAt: string | null;
    latestOrderAt?: string | null;
  } | null>(null);
  // Snapshot-derived KPI bundle. Optional — when `hasData` is true the
  // dashboard role components prefer these aggregates over walking the
  // live orders array (cheaper at scale). When absent or empty, the
  // components fall back to their existing live calculations.
  const [snapshotKpis, setSnapshotKpis] = useState<SnapshotKpiBundle | null>(
    null
  );

  const allBranches = seesAllBranches(role);

  useEffect(() => {
    setActiveDashboard(getDefaultDashboard(role));
  }, [role]);

  // Re-fetch whenever the role or branch changes — both can change the
  // server-side slice (allBranches flag) AND the client-side filter.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      // Live operational data (per-row arrays the role widgets consume)
      // + snapshot-backed summary metadata (freshness indicator). The
      // summary read is a separate server route because the matview is
      // service-role-only — see app/api/admin/dashboard/summary.
      const [next, summaryRes] = await Promise.all([
        fetchDashboardSnapshot({
          branchCode: branch.id,
          allBranches,
        }),
        fetchSnapshotSummary(branch.id, allBranches),
      ]);
      if (!cancelled) {
        setSnapshot(next);
        setSnapshotMeta(
          summaryRes
            ? {
                usingSnapshot: summaryRes.usingSnapshot,
                snapshotRefreshedAt: summaryRes.snapshotRefreshedAt,
                latestOrderAt: summaryRes.latestOrderAt,
              }
            : null
        );
        // Build the KPI bundle if we got snapshot rows. Empty / fallback
        // responses produce hasData=false so consumers know to fall
        // back to live calc.
        setSnapshotKpis(
          summaryRes ? assembleSnapshotKpis(summaryRes.rows ?? []) : null
        );
        setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branch.id, allBranches]);

  // Memoise the "branch-scoped" view used by widgets that should respect
  // the user's selection even when allBranches=true. Owner / hq_admin
  // looking at a single branch tab still see scoped numbers on the
  // FrontDesk / Production dashboards.
  const orders: AnalyticsOrder[] = snapshot?.orders ?? [];
  const expenses: ExpenseRow[] = snapshot?.expenses ?? [];

  const scopedOrders = useMemo(
    () => filterByBranch(orders, branch.id, allBranches),
    [orders, branch.id, allBranches]
  );

  const accessible = getAccessibleDashboards(role);

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      {/* Page Header */}
      <div className="mb-5 md:mb-6 flex flex-col md:flex-row md:items-end md:justify-between gap-4 border-l-4 border-yellow-400 pl-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS • {definition.labelTh}
          </p>
          <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
            แดชบอร์ด
          </h1>
          <p className="text-gray-600 mt-1 text-sm md:text-base">
            มุมมองตามบทบาท — เปลี่ยนบทบาทได้ที่แถบด้านซ้าย
          </p>
        </div>
        <div className="flex items-center gap-3 bg-white rounded-2xl border border-green-100 shadow-sm px-4 py-2">
          <BrandLogo size="sm" variant="onLight" />
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-gray-500">
              {language === "th" ? "สาขาที่เลือก" : "Current branch"}
            </p>
            <p className="text-sm font-semibold text-gray-800 truncate max-w-[220px]">
              {allBranches
                ? language === "th"
                  ? "ทุกสาขา"
                  : "All branches"
                : branch.shortLabel}
            </p>
            <p className="text-[10px] text-gray-500 truncate max-w-[220px]">
              {allBranches ? branch.shortLabel : branch.address}
            </p>
            {snapshotMeta && (
              <p
                className="text-[10px] mt-0.5 truncate max-w-[220px]"
                title={
                  snapshotMeta.usingSnapshot
                    ? language === "th"
                      ? `อ่านจาก dashboard_daily_snapshot · refresh ล่าสุด ${snapshotMeta.snapshotRefreshedAt}`
                      : `Source: dashboard_daily_snapshot · refreshed ${snapshotMeta.snapshotRefreshedAt}`
                    : language === "th"
                    ? "snapshot ยังว่าง — fallback อ่านสด"
                    : "snapshot empty — live fallback"
                }
              >
                {snapshotMeta.usingSnapshot ? (
                  <span className="text-green-700">
                    {language === "th" ? "📊 snapshot" : "📊 snapshot"} ·{" "}
                    {snapshotMeta.snapshotRefreshedAt ?? "—"}
                  </span>
                ) : (
                  <span className="text-yellow-700">
                    {language === "th" ? "⚡ live (fallback)" : "⚡ live (fallback)"}
                  </span>
                )}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Pilot quick access — big, obvious jumps to the new pilot flows.
          Mobile-first: full-width stacked on a phone, 3-up on tablet+. */}
      <div className="mb-5">
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-green-700">
          {language === "th" ? "เข้าใช้งานด่วน (Pilot)" : "Quick access (Pilot)"}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Link
            href="/mobile-intake"
            className="flex min-h-[60px] items-center gap-3 rounded-2xl bg-green-700 px-5 py-4 text-white shadow-sm transition hover:bg-green-800 active:bg-green-800"
          >
            <span className="text-2xl" aria-hidden>
              📱
            </span>
            <span className="text-base font-bold leading-tight">
              รับงานด้วยมือถือ
            </span>
          </Link>
          <Link
            href="/admin/intake-drafts"
            className="flex min-h-[60px] items-center gap-3 rounded-2xl border-2 border-green-600 bg-white px-5 py-4 text-green-800 shadow-sm transition hover:bg-green-50 active:bg-green-50"
          >
            <span className="text-2xl" aria-hidden>
              🗂️
            </span>
            <span className="text-base font-bold leading-tight">
              คิวงานจากมือถือ
            </span>
          </Link>
          <Link
            href="/admin/pricing-master"
            className="flex min-h-[60px] items-center gap-3 rounded-2xl border-2 border-green-600 bg-white px-5 py-4 text-green-800 shadow-sm transition hover:bg-green-50 active:bg-green-50"
          >
            <span className="text-2xl" aria-hidden>
              💲
            </span>
            <span className="text-base font-bold leading-tight">
              Pricing Master
            </span>
          </Link>
        </div>
      </div>

      {snapshot?.error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {snapshot.error}
        </div>
      )}

      {/* Dashboard tabs (only when role has more than one). The flex-nowrap +
          overflow-x-auto pair keeps every tap target large on a phone instead
          of squashing into two micro-rows. */}
      {accessible.length > 1 && (
        <div className="mb-4 flex gap-2 overflow-x-auto -mx-1 px-1 pb-1">
          {accessible.map((key) => {
            const isActive = key === activeDashboard;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setActiveDashboard(key)}
                className={`shrink-0 px-4 py-2 rounded-full text-sm font-medium border transition min-h-[40px] ${
                  isActive
                    ? "bg-green-700 border-green-700 text-white"
                    : "bg-white border-gray-200 text-gray-700 hover:bg-green-50"
                }`}
              >
                {DASHBOARD_LABELS[key].th}
              </button>
            );
          })}
        </div>
      )}

      {isLoading || !snapshot ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          กำลังโหลด...
        </div>
      ) : (
        <DashboardView
          dashboard={activeDashboard}
          orders={scopedOrders}
          allOrders={orders}
          expenses={expenses}
          branchId={branch.id}
          customerCount={snapshot.customerCount}
          snapshotKpis={snapshotKpis}
        />
      )}
    </div>
  );
}

function DashboardView({
  dashboard,
  orders,
  allOrders,
  expenses,
  branchId,
  customerCount,
  snapshotKpis,
}: {
  dashboard: DashboardKey;
  orders: AnalyticsOrder[];
  allOrders: AnalyticsOrder[];
  expenses: ExpenseRow[];
  branchId: string;
  customerCount: number;
  snapshotKpis: SnapshotKpiBundle | null;
}) {
  switch (dashboard) {
    case "frontdesk":
      return <FrontDeskDashboard orders={orders} customerCount={customerCount} />;
    case "production":
      return <ProductionDashboard orders={orders} />;
    case "accounting":
      // Accounting reads org-wide so they always see consolidated revenue.
      return (
        <AccountingDashboard
          orders={allOrders}
          expenses={expenses}
          snapshotKpis={snapshotKpis}
        />
      );
    case "manager":
      return (
        <ManagerDashboard
          orders={allOrders}
          expenses={expenses}
          branchId={branchId}
          snapshotKpis={snapshotKpis}
        />
      );
    case "executive":
      return (
        <ExecutiveDashboard
          orders={allOrders}
          expenses={expenses}
          customerCount={customerCount}
          snapshotKpis={snapshotKpis}
        />
      );
    default:
      return <FrontDeskDashboard orders={orders} customerCount={customerCount} />;
  }
}

/**
 * Call the snapshot-summary route. Returns null on failure so the page
 * shows live values without an indicator. This is purely informational
 * — the actual operational widgets keep reading from the live snapshot
 * fetcher and don't depend on the matview at all.
 */
async function fetchSnapshotSummary(
  branchCode: string,
  allBranches: boolean
): Promise<{
  usingSnapshot: boolean;
  snapshotRefreshedAt: string | null;
  latestOrderAt?: string | null;
  rows: DailySnapshotRow[];
} | null> {
  try {
    const params = new URLSearchParams();
    if (!allBranches && branchCode) params.set("branchCode", branchCode);
    if (allBranches) params.set("branchCode", "all");
    const res = await fetch(`/api/admin/dashboard/summary?${params.toString()}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      ok?: boolean;
      usingSnapshot?: boolean;
      snapshotRefreshedAt?: string | null;
      latestOrderAt?: string | null;
      rows?: DailySnapshotRow[];
    };
    if (!json.ok) return null;
    return {
      usingSnapshot: !!json.usingSnapshot,
      snapshotRefreshedAt: json.snapshotRefreshedAt ?? null,
      latestOrderAt: json.latestOrderAt ?? null,
      rows: json.rows ?? [],
    };
  } catch {
    return null;
  }
}
