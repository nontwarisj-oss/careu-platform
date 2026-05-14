// Snapshot-backed KPI helpers. Mirrors the date-bucketed metrics in
// lib/dashboardKpi.ts (`getSalesToday`, `getSalesThisMonth`, …) but reads
// from `public.dashboard_daily_snapshot` rows instead of walking the live
// orders array.
//
// Why a parallel module: the existing helpers in lib/dashboardKpi.ts
// consume `AnalyticsOrder[]` — per-order rows with status / urgent /
// payment_status / etc. The matview is day-granular and exposes
// completed_orders / revenue / urgent_orders aggregates per day. The two
// surfaces compute the same numbers but read from different shapes, so
// having two implementations keeps each one honest.
//
// Pure functions over the daily rows. Server-friendly (no React).

import type { DailySnapshotRow } from "@/lib/aggregationService";

// ---------- Date utilities -----------------------------------------------

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

function firstOfLastMonth(d: Date): string {
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();
  const lastMonth = month === 0 ? 11 : month - 1;
  const lastYear = month === 0 ? year - 1 : year;
  return `${lastYear}-${String(lastMonth + 1).padStart(2, "0")}-01`;
}

function lastOfLastMonth(d: Date): string {
  // First-of-current minus one day → last-of-last.
  const firstCurrent = new Date(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const minusOne = new Date(firstCurrent.getTime() - 24 * 60 * 60 * 1000);
  const y = minusOne.getFullYear();
  const m = String(minusOne.getMonth() + 1).padStart(2, "0");
  const day = String(minusOne.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- Single-metric helpers ----------------------------------------

/** Sum revenue from rows whose work_date matches today's local ISO. */
export function getSalesTodayFromSnapshot(
  rows: DailySnapshotRow[]
): number {
  const today = todayISODate();
  return rows.reduce(
    (acc, r) => (r.workDate === today ? acc + r.revenue : acc),
    0
  );
}

/** Sum revenue across the current calendar month. */
export function getSalesThisMonthFromSnapshot(
  rows: DailySnapshotRow[]
): number {
  const start = firstOfMonth(new Date());
  return rows.reduce(
    (acc, r) => (r.workDate >= start ? acc + r.revenue : acc),
    0
  );
}

/** Sum revenue across the prior calendar month. */
export function getSalesLastMonthFromSnapshot(
  rows: DailySnapshotRow[]
): number {
  const start = firstOfLastMonth(new Date());
  const end = lastOfLastMonth(new Date());
  return rows.reduce(
    (acc, r) =>
      r.workDate >= start && r.workDate <= end ? acc + r.revenue : acc,
    0
  );
}

/** % change vs. last month, returns 0 when last month was zero. */
export function getMonthOverMonthPctFromSnapshot(
  rows: DailySnapshotRow[]
): number {
  const current = getSalesThisMonthFromSnapshot(rows);
  const previous = getSalesLastMonthFromSnapshot(rows);
  if (previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

/** Total order count this month (any status). */
export function getOrdersThisMonthFromSnapshot(
  rows: DailySnapshotRow[]
): number {
  const start = firstOfMonth(new Date());
  return rows.reduce(
    (acc, r) => (r.workDate >= start ? acc + r.totalOrders : acc),
    0
  );
}

/** Completed orders this month. */
export function getCompletedThisMonthFromSnapshot(
  rows: DailySnapshotRow[]
): number {
  const start = firstOfMonth(new Date());
  return rows.reduce(
    (acc, r) => (r.workDate >= start ? acc + r.completedOrders : acc),
    0
  );
}

/** Urgent orders today. */
export function getUrgentTodayFromSnapshot(
  rows: DailySnapshotRow[]
): number {
  const today = todayISODate();
  return rows.reduce(
    (acc, r) => (r.workDate === today ? acc + r.urgentOrders : acc),
    0
  );
}

// ---------- Bundle ---------------------------------------------------------

export type SnapshotKpiBundle = {
  /** True when the bundle was built from matview rows; false when the
   *  caller passed an empty array (snapshot not refreshed yet). */
  hasData: boolean;
  /** Latest work_date present in the rows, ISO YYYY-MM-DD. NULL when empty. */
  latestWorkDate: string | null;
  salesToday: number;
  salesThisMonth: number;
  salesLastMonth: number;
  monthOverMonthPct: number;
  ordersThisMonth: number;
  completedThisMonth: number;
  urgentToday: number;
};

/**
 * Compose every date-bucketed metric in one pass so consumers can call
 * one function instead of seven. Returns `hasData: false` when the rows
 * array is empty — the page should then fall back to the live helpers
 * in lib/dashboardKpi.ts so widgets don't render zeros.
 */
export function assembleSnapshotKpis(rows: DailySnapshotRow[]): SnapshotKpiBundle {
  if (rows.length === 0) {
    return {
      hasData: false,
      latestWorkDate: null,
      salesToday: 0,
      salesThisMonth: 0,
      salesLastMonth: 0,
      monthOverMonthPct: 0,
      ordersThisMonth: 0,
      completedThisMonth: 0,
      urgentToday: 0,
    };
  }
  const latestWorkDate = rows.reduce<string | null>(
    (acc, r) => (!acc || r.workDate > acc ? r.workDate : acc),
    null
  );
  return {
    hasData: true,
    latestWorkDate,
    salesToday: getSalesTodayFromSnapshot(rows),
    salesThisMonth: getSalesThisMonthFromSnapshot(rows),
    salesLastMonth: getSalesLastMonthFromSnapshot(rows),
    monthOverMonthPct: getMonthOverMonthPctFromSnapshot(rows),
    ordersThisMonth: getOrdersThisMonthFromSnapshot(rows),
    completedThisMonth: getCompletedThisMonthFromSnapshot(rows),
    urgentToday: getUrgentTodayFromSnapshot(rows),
  };
}
