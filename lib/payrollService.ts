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

// ---------- Period + item writes ------------------------------------------
//
// Owner / hq_admin only — every API route that calls these writers must
// gate on the role. RLS on payroll_periods and technician_payroll_items
// already restricts branch_manager / front_staff / technician to read-only
// or no access, so a missed UI guard still won't corrupt the data.

export type PayrollPeriodRow = {
  id: string;
  branch_id: string;
  year: number;
  month: number;
  start_date: string;
  end_date: string;
  status: "open" | "finalized" | "paid" | "cancelled";
  finalized_at: string | null;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type PayrollItemRow = {
  id: string;
  payroll_period_id: string;
  technician_profile_id: string | null;
  daily_wage_snapshot: number | null;
  target_multiplier_snapshot: number | null;
  base_wage: number;
  days_worked: number;
  production_value: number;
  target_value: number;
  performance_ratio: number;
  bonus_amount: number;
  deduction_amount: number;
  final_pay: number;
  notes: string | null;
};

export type FindOrCreatePeriodInput = {
  /** branches.id (uuid). */
  branchId: string;
  year: number;
  month: number;
  actorId?: string | null;
};

/**
 * Idempotent — returns the existing period when one matches
 * (branch_id, year, month). Used by the admin UI's "Open period"
 * button so re-pressing it is safe.
 */
export async function findOrCreatePeriod(
  input: FindOrCreatePeriodInput
): Promise<{ ok: true; period: PayrollPeriodRow } | { ok: false; reason: string }> {
  if (input.month < 1 || input.month > 12) {
    return { ok: false, reason: "Month must be 1–12" };
  }
  const admin = (await import("@/lib/supabaseAdmin")).getSupabaseAdmin();
  if (!admin) {
    return { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า" };
  }

  const existing = await admin
    .from("payroll_periods")
    .select("*")
    .eq("branch_id", input.branchId)
    .eq("year", input.year)
    .eq("month", input.month)
    .maybeSingle();
  if (!existing.error && existing.data) {
    return { ok: true, period: existing.data as PayrollPeriodRow };
  }

  // Compute start/end date for the calendar month.
  const startDate = `${input.year}-${String(input.month).padStart(2, "0")}-01`;
  const endDateRaw = new Date(Date.UTC(input.year, input.month, 0)); // last day
  const endDate = `${endDateRaw.getUTCFullYear()}-${String(
    endDateRaw.getUTCMonth() + 1
  ).padStart(2, "0")}-${String(endDateRaw.getUTCDate()).padStart(2, "0")}`;

  const insertRes = await admin
    .from("payroll_periods")
    .insert({
      branch_id: input.branchId,
      year: input.year,
      month: input.month,
      start_date: startDate,
      end_date: endDate,
      status: "open",
      created_by: input.actorId ?? null,
      updated_by: input.actorId ?? null,
    })
    .select("*")
    .single();
  if (insertRes.error || !insertRes.data) {
    return { ok: false, reason: insertRes.error?.message ?? "Insert failed" };
  }
  return { ok: true, period: insertRes.data as PayrollPeriodRow };
}

export type UpsertItemInput = {
  payrollPeriodId: string;
  technicianProfileId: string;
  baseWage: number;
  dailyWageSnapshot: number | null;
  targetMultiplierSnapshot: number | null;
  daysWorked: number;
  productionValue: number;
  targetValue: number;
  performanceRatio: number;
  bonusAmount: number;
  /** Optional — what the bonus engine recommended at save time. The route
   *  defaults to the engine's output when omitted, so callers that don't
   *  pass it still get an honest audit trail. */
  bonusSuggested?: number | null;
  /** Optional — rule version that produced bonusSuggested. Defaults to the
   *  current engine version. */
  bonusRuleVersion?: string | null;
  deductionAmount: number;
  notes?: string | null;
  actorId?: string | null;
};

/**
 * Upsert one technician_payroll_items row keyed by
 * (payroll_period_id, technician_profile_id). `final_pay` is recomputed
 * server-side: base + bonus − deduction. Owner-decided bonus / deduction
 * stay as-passed; the UI can pre-fill them with estimates.
 *
 * Refuses to write when the period status is `paid` (immutability rule).
 * `finalized` periods accept edits — owners often adjust bonuses after
 * finalization but before paying out.
 */
export async function upsertPayrollItem(
  input: UpsertItemInput
): Promise<{ ok: true; item: PayrollItemRow } | { ok: false; reason: string }> {
  const admin = (await import("@/lib/supabaseAdmin")).getSupabaseAdmin();
  if (!admin) {
    return { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า" };
  }
  const periodRes = await admin
    .from("payroll_periods")
    .select("status")
    .eq("id", input.payrollPeriodId)
    .maybeSingle();
  if (periodRes.error || !periodRes.data) {
    return { ok: false, reason: "ไม่พบ payroll period" };
  }
  if ((periodRes.data as { status: string }).status === "paid") {
    return {
      ok: false,
      reason: "Period นี้จ่ายเงินแล้ว — แก้ไขรายการช่างต่อไปไม่ได้",
    };
  }

  const finalPay =
    Number(input.baseWage) +
    Number(input.bonusAmount) -
    Number(input.deductionAmount);

  // Always recompute the engine's suggestion server-side so a caller
  // can't lie about what was recommended. If the caller passed
  // bonusSuggested / bonusRuleVersion explicitly we trust those
  // (used when the UI computed the same thing) — but the default is
  // the freshly-derived suggestion.
  const bonusModule = await import("@/lib/bonusEngine");
  const computed = bonusModule.calculateSuggestedBonus({
    performanceRatio: input.performanceRatio,
    baseWage: input.baseWage,
  });
  const bonusSuggested =
    input.bonusSuggested !== undefined && input.bonusSuggested !== null
      ? Number(input.bonusSuggested)
      : computed.amount;
  const bonusRuleVersion =
    input.bonusRuleVersion ?? computed.ruleVersion;

  const payload = {
    payroll_period_id: input.payrollPeriodId,
    technician_profile_id: input.technicianProfileId,
    daily_wage_snapshot: input.dailyWageSnapshot,
    target_multiplier_snapshot: input.targetMultiplierSnapshot,
    base_wage: input.baseWage,
    days_worked: input.daysWorked,
    production_value: input.productionValue,
    target_value: input.targetValue,
    performance_ratio: input.performanceRatio,
    bonus_amount: input.bonusAmount,
    bonus_suggested: bonusSuggested,
    bonus_rule_version: bonusRuleVersion,
    deduction_amount: input.deductionAmount,
    final_pay: finalPay,
    notes: input.notes ?? null,
    updated_by: input.actorId ?? null,
  };

  const res = await admin
    .from("technician_payroll_items")
    .upsert(payload, {
      onConflict: "payroll_period_id,technician_profile_id",
    })
    .select("*")
    .single();
  if (res.error || !res.data) {
    return { ok: false, reason: res.error?.message ?? "Upsert failed" };
  }
  return { ok: true, item: res.data as PayrollItemRow };
}

export type PeriodTransitionResult =
  | { ok: true; period: PayrollPeriodRow }
  | { ok: false; reason: string };

async function transitionPeriod(
  periodId: string,
  to: PayrollPeriodRow["status"],
  actorId: string | null
): Promise<PeriodTransitionResult> {
  const admin = (await import("@/lib/supabaseAdmin")).getSupabaseAdmin();
  if (!admin) {
    return { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า" };
  }
  const periodRes = await admin
    .from("payroll_periods")
    .select("status")
    .eq("id", periodId)
    .maybeSingle();
  if (periodRes.error || !periodRes.data) {
    return { ok: false, reason: "ไม่พบ payroll period" };
  }
  const cur = (periodRes.data as { status: string }).status;
  if (cur === to) {
    // Idempotent — return the period in its current shape.
    const fresh = await admin
      .from("payroll_periods")
      .select("*")
      .eq("id", periodId)
      .single();
    if (fresh.error || !fresh.data) {
      return { ok: false, reason: fresh.error?.message ?? "Read failed" };
    }
    return { ok: true, period: fresh.data as PayrollPeriodRow };
  }
  if (to === "finalized" && cur !== "open") {
    return { ok: false, reason: `ไม่สามารถ finalize period ที่สถานะ "${cur}"` };
  }
  if (to === "paid" && cur !== "finalized") {
    return { ok: false, reason: `ต้อง finalize ก่อนถึงจะกด "จ่ายแล้ว" ได้ (สถานะปัจจุบัน: ${cur})` };
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: to,
    updated_by: actorId,
  };
  if (to === "finalized") {
    patch.finalized_at = now;
    patch.finalized_by = actorId;
  }
  if (to === "paid") {
    patch.paid_at = now;
    patch.paid_by = actorId;
  }
  const res = await admin
    .from("payroll_periods")
    .update(patch)
    .eq("id", periodId)
    .select("*")
    .single();
  if (res.error || !res.data) {
    return { ok: false, reason: res.error?.message ?? "Update failed" };
  }
  return { ok: true, period: res.data as PayrollPeriodRow };
}

export function finalizePeriod(
  periodId: string,
  actorId: string | null
): Promise<PeriodTransitionResult> {
  return transitionPeriod(periodId, "finalized", actorId);
}

export function markPeriodPaid(
  periodId: string,
  actorId: string | null
): Promise<PeriodTransitionResult> {
  return transitionPeriod(periodId, "paid", actorId);
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
