// Payroll calculation helpers. Pure functions over the technician KPI data
// (lib/technicianKpi.ts) plus branch-level cost rollups.
//
// Scope discipline:
//   • Calculation only. No INSERT/UPDATE to payroll_periods or
//     technician_payroll_items in this commit — that's the next phase.
//   • Owner-decided fields (bonus / deduction) are inputs, not outputs.
//     The helpers produce target / production / suggested base wage;
//     the eventual UI lets the owner override final_pay.
//
// Server-safe (no React imports). Callable from route handlers + future
// admin pages.

import supabase from "@/lib/supabase";
import {
  effectiveDailyTarget,
  type TechnicianProfile,
} from "@/lib/technicianService";
import {
  getMonthlyKpi,
  type MonthlyKpi,
} from "@/lib/technicianKpi";

// ---------- Pure math ----------------------------------------------------

/**
 * Production target for a contiguous window of work days.
 *   target = effectiveDailyTarget(tech) × daysWorked
 *
 * Negative `daysWorked` is clamped to 0 so callers can safely pass diffs.
 */
export function calculateProductionTarget(
  tech: TechnicianProfile,
  daysWorked: number
): number {
  const days = Math.max(0, Math.floor(daysWorked));
  return effectiveDailyTarget(tech) * days;
}

/**
 * production / target, clamped at 0 when no target is configured.
 * Returned as a fractional ratio (1.25 means 125 % of target).
 */
export function calculatePerformanceRatio(
  production: number,
  target: number
): number {
  if (!Number.isFinite(target) || target <= 0) return 0;
  const safeProduction = Math.max(0, Number(production) || 0);
  return safeProduction / target;
}

// ---------- Monthly estimate ----------------------------------------------

export type EstimatedPayroll = {
  technicianId: string;
  year: number;
  month: number;
  daysWorked: number;
  /** dailyWage × daysWorked — the floor the technician will be paid. */
  baseWage: number;
  /** Snapshot of tech.daily_wage at estimation time. */
  dailyWageSnapshot: number;
  /** Snapshot of tech.target_multiplier at estimation time. */
  targetMultiplierSnapshot: number;
  productionValue: number;
  targetValue: number;
  performanceRatio: number;
  /** No bonus/deduction logic yet — owner enters manually. estimatedFinalPay
   *  equals baseWage by default and is what the UI suggests as the
   *  starting value when the owner reviews. */
  estimatedFinalPay: number;
  /** True when production matched or beat the cumulative target. */
  aboveTarget: boolean;
  /** Underlying monthly KPI breakdown the estimate was built from. */
  kpi: MonthlyKpi;
};

/**
 * Compute one technician's estimated payroll for a calendar month.
 *
 *   • baseWage = daily_wage × daysWorked (from KPI view)
 *   • target   = effectiveDailyTarget × daysWorked
 *   • ratio    = totalAssigned / target
 *   • final    = baseWage (no automatic bonus this phase)
 *
 * `daysWorked` is "days the tech had any assignment that month". Days off
 * are not counted, which avoids inflating the target denominator.
 */
export async function calculateEstimatedPayroll(
  tech: TechnicianProfile,
  year: number,
  month: number
): Promise<EstimatedPayroll> {
  const kpi = await getMonthlyKpi(tech, year, month);
  const dailyWage = Number(tech.daily_wage ?? 0);
  const multiplier = Number(tech.target_multiplier ?? 3);
  const baseWage = dailyWage * kpi.daysWorked;
  const target = effectiveDailyTarget(tech) * kpi.daysWorked;
  const ratio = calculatePerformanceRatio(kpi.totalAssigned, target);

  return {
    technicianId: tech.id,
    year,
    month,
    daysWorked: kpi.daysWorked,
    baseWage,
    dailyWageSnapshot: dailyWage,
    targetMultiplierSnapshot: multiplier,
    productionValue: kpi.totalAssigned,
    targetValue: target,
    performanceRatio: ratio,
    estimatedFinalPay: baseWage,
    aboveTarget: target > 0 && kpi.totalAssigned >= target,
    kpi,
  };
}

// ---------- Branch labor cost ---------------------------------------------

export type BranchLaborCost = {
  /** branches.id (uuid). */
  branchId: string;
  fromDate: string;
  toDate: string;
  /** Number of unique technicians who had at least one work day in window. */
  technicianCount: number;
  /** Total work-days across all technicians (one tech-day = one row in KPI view). */
  totalWorkDays: number;
  /** Sum of (daily_wage × days_worked) for each technician. */
  laborCost: number;
  /** Sum of production_value (defaults to price - material_cost where null). */
  totalProduction: number;
  /** Sum of effectiveDailyTarget × days_worked across all techs. */
  totalTarget: number;
  /** technicianId → per-tech rollup, for drill-down. */
  byTechnician: Record<
    string,
    { daysWorked: number; laborCost: number; production: number; target: number }
  >;
};

const TECHNICIAN_COLUMNS =
  "id, user_id, branch_id, display_name, active, skill_tags, daily_wage, target_multiplier, productivity_target, created_at, updated_at";

/**
 * Sum labor cost for one branch over a date window. Uses the daily KPI view
 * to count days worked per technician × the technician's current daily_wage.
 *
 * `branchId` is the uuid (branches.id), matching technician_profiles.branch_id.
 *
 * The KPI view inherits orders' RLS, so a branch_manager caller automatically
 * gets only their own branch's numbers; admins see whatever branch they ask for.
 */
export async function calculateBranchLaborCost(
  branchId: string,
  fromDate: string,
  toDate: string
): Promise<BranchLaborCost> {
  // 1. Fetch all (active or inactive) technicians pinned to the branch.
  //    Including inactive ones means a tech who left mid-window still
  //    contributes their work days to the rollup.
  const techRes = await supabase
    .from("technician_profiles")
    .select(TECHNICIAN_COLUMNS)
    .eq("branch_id", branchId);

  if (techRes.error || !techRes.data) {
    return emptyBranchLaborCost(branchId, fromDate, toDate);
  }
  const techs = techRes.data as TechnicianProfile[];
  if (techs.length === 0) {
    return emptyBranchLaborCost(branchId, fromDate, toDate);
  }
  const byId = new Map(techs.map((t) => [t.id, t]));

  // 2. Pull the daily KPI rows in the window for those technicians.
  const kpiRes = await supabase
    .from("technician_daily_kpi")
    .select("technician_id, work_date, assigned_value")
    .gte("work_date", fromDate)
    .lte("work_date", toDate)
    .in("technician_id", techs.map((t) => t.id));

  const byTechnician: BranchLaborCost["byTechnician"] = {};
  let laborCost = 0;
  let totalWorkDays = 0;
  let totalProduction = 0;
  let totalTarget = 0;

  if (!kpiRes.error && kpiRes.data) {
    // Group rows by tech, then count days + sum production.
    const grouped = new Map<string, { days: number; production: number }>();
    for (const row of kpiRes.data as Array<{
      technician_id: string;
      work_date: string;
      assigned_value: number | string;
    }>) {
      const existing = grouped.get(row.technician_id) ?? {
        days: 0,
        production: 0,
      };
      existing.days += 1;
      existing.production += Number(row.assigned_value ?? 0);
      grouped.set(row.technician_id, existing);
    }

    for (const [techId, agg] of grouped.entries()) {
      const tech = byId.get(techId);
      if (!tech) continue;
      const wage = Number(tech.daily_wage ?? 0);
      const target = effectiveDailyTarget(tech) * agg.days;
      const techLabor = wage * agg.days;
      byTechnician[techId] = {
        daysWorked: agg.days,
        laborCost: techLabor,
        production: agg.production,
        target,
      };
      laborCost += techLabor;
      totalWorkDays += agg.days;
      totalProduction += agg.production;
      totalTarget += target;
    }
  }

  return {
    branchId,
    fromDate,
    toDate,
    technicianCount: Object.keys(byTechnician).length,
    totalWorkDays,
    laborCost,
    totalProduction,
    totalTarget,
    byTechnician,
  };
}

function emptyBranchLaborCost(
  branchId: string,
  fromDate: string,
  toDate: string
): BranchLaborCost {
  return {
    branchId,
    fromDate,
    toDate,
    technicianCount: 0,
    totalWorkDays: 0,
    laborCost: 0,
    totalProduction: 0,
    totalTarget: 0,
    byTechnician: {},
  };
}

// ---------- Branch profit fetch -------------------------------------------

export type BranchMonthlyProfit = {
  branchCode: string;
  monthStart: string;     // YYYY-MM-DD (first day of month)
  revenue: number;
  materialCost: number;
  laborCost: number;
  operationalExpenses: number;
  grossProfit: number;
  completedOrders: number;
  expenseCount: number;
};

/**
 * Read the branch_monthly_profit view for a date window. RLS on the
 * underlying tables means branch-scoped callers see only their own branch;
 * admins see everything in the window.
 */
export async function fetchBranchMonthlyProfit(
  fromMonth: string, // YYYY-MM-01
  toMonth: string    // YYYY-MM-01 (inclusive)
): Promise<BranchMonthlyProfit[]> {
  const res = await supabase
    .from("branch_monthly_profit")
    .select(
      "branch_code, month_start, revenue, material_cost, labor_cost, operational_expenses, gross_profit, completed_orders, expense_count"
    )
    .gte("month_start", fromMonth)
    .lte("month_start", toMonth)
    .order("month_start", { ascending: false });
  if (res.error || !res.data) return [];
  return (res.data as Array<{
    branch_code: string;
    month_start: string;
    revenue: number | string;
    material_cost: number | string;
    labor_cost: number | string;
    operational_expenses: number | string;
    gross_profit: number | string;
    completed_orders: number | string;
    expense_count: number | string;
  }>).map((row) => ({
    branchCode: row.branch_code,
    monthStart: row.month_start,
    revenue: Number(row.revenue ?? 0),
    materialCost: Number(row.material_cost ?? 0),
    laborCost: Number(row.labor_cost ?? 0),
    operationalExpenses: Number(row.operational_expenses ?? 0),
    grossProfit: Number(row.gross_profit ?? 0),
    completedOrders: Number(row.completed_orders ?? 0),
    expenseCount: Number(row.expense_count ?? 0),
  }));
}
