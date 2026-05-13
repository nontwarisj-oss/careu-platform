// Technician KPI helpers. Pure read-side aggregations over the
// `technician_daily_kpi` view, plus monthly + ranking rollups.
//
// All queries inherit branch isolation from public.orders' RLS via the
// view — a branch-scoped caller only sees their own branch's totals,
// admins see all.
//
// No payroll math here. This module produces the numbers a future payroll
// UI will read; that UI lives in a separate phase.

import supabase from "@/lib/supabase";
import {
  effectiveDailyTarget,
  type TechnicianProfile,
} from "@/lib/technicianService";

// ---------- Types ---------------------------------------------------------

export type DailyKpi = {
  technicianId: string;
  workDate: string;          // YYYY-MM-DD
  assignedCount: number;
  assignedValue: number;
  completedCount: number;
  completedValue: number;
  targetValue: number;       // effective daily target (Baht)
  performanceRatio: number;  // assignedValue / targetValue (0 when no target)
  aboveTarget: boolean;
};

export type MonthlyKpi = {
  technicianId: string;
  year: number;
  month: number;              // 1–12
  totalAssigned: number;
  totalCompleted: number;
  totalTarget: number;        // dailyTarget × business days worked
  daysWorked: number;
  daysAboveTarget: number;
  daysBelowTarget: number;
  performanceRatio: number;   // totalAssigned / totalTarget
};

export type TechnicianRanking = {
  technicianId: string;
  totalOrders: number;
  totalValue: number;
};

// ---------- Row helpers ---------------------------------------------------

type RawDailyRow = {
  technician_id: string;
  work_date: string;
  assigned_count: number | string;
  assigned_value: number | string;
  completed_count: number | string;
  completed_value: number | string;
};

function toNum(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------- Daily KPI -----------------------------------------------------

/**
 * One day of KPI for a single technician. Returns null when no orders were
 * assigned that day (the view doesn't emit zero rows).
 */
export async function getDailyKpi(
  technician: TechnicianProfile,
  date: string
): Promise<DailyKpi | null> {
  const target = effectiveDailyTarget(technician);
  const { data, error } = await supabase
    .from("technician_daily_kpi")
    .select(
      "technician_id, work_date, assigned_count, assigned_value, completed_count, completed_value"
    )
    .eq("technician_id", technician.id)
    .eq("work_date", date)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as RawDailyRow;
  const assignedValue = toNum(row.assigned_value);
  const completedValue = toNum(row.completed_value);
  const performanceRatio = target > 0 ? assignedValue / target : 0;

  return {
    technicianId: row.technician_id,
    workDate: row.work_date,
    assignedCount: toNum(row.assigned_count),
    assignedValue,
    completedCount: toNum(row.completed_count),
    completedValue,
    targetValue: target,
    performanceRatio,
    aboveTarget: target > 0 && assignedValue >= target,
  };
}

// ---------- Monthly KPI ---------------------------------------------------

/**
 * Aggregate a full calendar month's worth of daily rows.
 *
 *   • totalAssigned / totalCompleted: sum across the month.
 *   • daysAboveTarget / daysBelowTarget: count of days where
 *     assignedValue ≥ / < the technician's daily target.
 *   • totalTarget: dailyTarget × daysWorked. Using "days worked" instead of
 *     "business days in month" avoids penalising a tech who took a day off
 *     by inflating the denominator.
 */
export async function getMonthlyKpi(
  technician: TechnicianProfile,
  year: number,
  month: number // 1-indexed
): Promise<MonthlyKpi> {
  const startDate = formatDate(new Date(Date.UTC(year, month - 1, 1)));
  const endDate = formatDate(new Date(Date.UTC(year, month, 1)));
  const dailyTarget = effectiveDailyTarget(technician);

  const { data, error } = await supabase
    .from("technician_daily_kpi")
    .select("work_date, assigned_value, completed_value")
    .eq("technician_id", technician.id)
    .gte("work_date", startDate)
    .lt("work_date", endDate);

  if (error || !data) {
    return emptyMonthly(technician.id, year, month);
  }

  let totalAssigned = 0;
  let totalCompleted = 0;
  let daysAbove = 0;
  let daysBelow = 0;
  for (const row of data as Array<{
    work_date: string;
    assigned_value: number | string;
    completed_value: number | string;
  }>) {
    const assigned = toNum(row.assigned_value);
    totalAssigned += assigned;
    totalCompleted += toNum(row.completed_value);
    if (dailyTarget > 0) {
      if (assigned >= dailyTarget) daysAbove += 1;
      else daysBelow += 1;
    }
  }

  const daysWorked = (data as unknown[]).length;
  const totalTarget = dailyTarget * daysWorked;
  const performanceRatio = totalTarget > 0 ? totalAssigned / totalTarget : 0;

  return {
    technicianId: technician.id,
    year,
    month,
    totalAssigned,
    totalCompleted,
    totalTarget,
    daysWorked,
    daysAboveTarget: daysAbove,
    daysBelowTarget: daysBelow,
    performanceRatio,
  };
}

function emptyMonthly(
  technicianId: string,
  year: number,
  month: number
): MonthlyKpi {
  return {
    technicianId,
    year,
    month,
    totalAssigned: 0,
    totalCompleted: 0,
    totalTarget: 0,
    daysWorked: 0,
    daysAboveTarget: 0,
    daysBelowTarget: 0,
    performanceRatio: 0,
  };
}

// ---------- Branch ranking ------------------------------------------------

/**
 * Rank technicians by total assigned value within the given date window.
 * Returns only technicians who had assignments in the window; sorted
 * descending by `totalValue`. Branch isolation is delegated to RLS on
 * the underlying orders table — a branch-scoped caller only sees their
 * own branch's data, admins see all.
 */
export async function rankTechnicians(
  fromDate: string, // YYYY-MM-DD inclusive
  toDate: string    // YYYY-MM-DD inclusive
): Promise<TechnicianRanking[]> {
  const { data, error } = await supabase
    .from("technician_daily_kpi")
    .select("technician_id, assigned_count, assigned_value")
    .gte("work_date", fromDate)
    .lte("work_date", toDate);

  if (error || !data) return [];

  const rollup = new Map<string, { count: number; value: number }>();
  for (const row of data as Array<{
    technician_id: string;
    assigned_count: number | string;
    assigned_value: number | string;
  }>) {
    const existing = rollup.get(row.technician_id) ?? { count: 0, value: 0 };
    existing.count += toNum(row.assigned_count);
    existing.value += toNum(row.assigned_value);
    rollup.set(row.technician_id, existing);
  }

  return Array.from(rollup.entries())
    .map(([technicianId, v]) => ({
      technicianId,
      totalOrders: v.count,
      totalValue: v.value,
    }))
    .sort((a, b) => b.totalValue - a.totalValue);
}

// ---------- utils ---------------------------------------------------------

function formatDate(d: Date): string {
  // YYYY-MM-DD in UTC. Postgres date comparison ignores TZ so this is safe.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
