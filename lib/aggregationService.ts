// Aggregation service — read surface that points at the materialised
// `dashboard_daily_snapshot` view + the `branch_monthly_profit` view from
// migration 20260525. The point of this module is to give the dashboard
// + future BI layer one import path so the underlying storage can move
// (materialised view → external warehouse) without rewriting consumers.
//
// Today's foundation only ships a handful of summaries. New summaries
// MUST go through this module too — never query the matview directly from
// a page component.
//
// Server-friendly. Uses the service-role admin client so reads bypass
// the matview's revoked `authenticated` privileges. Branch isolation is
// enforced by every helper applying an explicit `.eq("branch_code", …)`
// when the caller passes one, and admin routes that surface this data to
// branch-scoped roles MUST scope the request first.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// ---------- Daily snapshot reads ------------------------------------------

export type DailySnapshotRow = {
  branchCode: string | null;
  workDate: string;
  totalOrders: number;
  completedOrders: number;
  readyOrders: number;
  urgentOrders: number;
  revenue: number;
  paidRevenue: number;
  urgentFeeTotal: number;
  materialCostTotal: number;
  laborCostTotal: number;
};

type RawSnapshot = {
  branch_code: string | null;
  work_date: string;
  total_orders: number | string;
  completed_orders: number | string;
  ready_orders: number | string;
  urgent_orders: number | string;
  revenue: number | string;
  paid_revenue: number | string;
  urgent_fee_total: number | string;
  material_cost_total: number | string;
  labor_cost_total: number | string;
};

function toRow(raw: RawSnapshot): DailySnapshotRow {
  return {
    branchCode: raw.branch_code,
    workDate: raw.work_date,
    totalOrders: Number(raw.total_orders ?? 0),
    completedOrders: Number(raw.completed_orders ?? 0),
    readyOrders: Number(raw.ready_orders ?? 0),
    urgentOrders: Number(raw.urgent_orders ?? 0),
    revenue: Number(raw.revenue ?? 0),
    paidRevenue: Number(raw.paid_revenue ?? 0),
    urgentFeeTotal: Number(raw.urgent_fee_total ?? 0),
    materialCostTotal: Number(raw.material_cost_total ?? 0),
    laborCostTotal: Number(raw.labor_cost_total ?? 0),
  };
}

/**
 * Pull rows from the materialised snapshot. Caller is responsible for
 * branch scoping — pass `branchCode` to restrict to one branch, or omit
 * for cross-branch admins. Bounded date window (default 30 days) keeps
 * the row count predictable.
 */
export async function fetchBranchSalesSummary(opts: {
  branchCode?: string | null;
  fromDate?: string;
  toDate?: string;
} = {}): Promise<DailySnapshotRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const to = opts.toDate ?? new Date().toISOString().slice(0, 10);
  const fromDate =
    opts.fromDate ??
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let q = admin
    .from("dashboard_daily_snapshot")
    .select(
      "branch_code, work_date, total_orders, completed_orders, ready_orders, urgent_orders, revenue, paid_revenue, urgent_fee_total, material_cost_total, labor_cost_total"
    )
    .gte("work_date", fromDate)
    .lte("work_date", to)
    .order("work_date", { ascending: false });
  if (opts.branchCode) q = q.eq("branch_code", opts.branchCode);
  const { data, error } = await q;
  if (error || !data) return [];
  return (data as RawSnapshot[]).map(toRow);
}

// ---------- Payroll totals -------------------------------------------------

export type PayrollTotals = {
  branchCode: string | null;
  year: number;
  month: number;
  techniciansPaid: number;
  baseWageTotal: number;
  bonusTotal: number;
  deductionTotal: number;
  finalPayTotal: number;
  productionValueTotal: number;
  targetValueTotal: number;
};

/**
 * Roll up technician_payroll_items rows for a (branch, year, month) tuple.
 * Returns zeros when no payroll period exists yet so the dashboard can
 * render a placeholder without throwing.
 */
export async function fetchPayrollTotals(opts: {
  branchId: string;        // branches.id (uuid)
  branchCode?: string | null;
  year: number;
  month: number;
}): Promise<PayrollTotals> {
  const admin = getSupabaseAdmin();
  const empty: PayrollTotals = {
    branchCode: opts.branchCode ?? null,
    year: opts.year,
    month: opts.month,
    techniciansPaid: 0,
    baseWageTotal: 0,
    bonusTotal: 0,
    deductionTotal: 0,
    finalPayTotal: 0,
    productionValueTotal: 0,
    targetValueTotal: 0,
  };
  if (!admin) return empty;

  const periodRes = await admin
    .from("payroll_periods")
    .select("id")
    .eq("branch_id", opts.branchId)
    .eq("year", opts.year)
    .eq("month", opts.month)
    .maybeSingle();
  if (periodRes.error || !periodRes.data) return empty;
  const periodId = (periodRes.data as { id: string }).id;

  const itemsRes = await admin
    .from("technician_payroll_items")
    .select(
      "base_wage, bonus_amount, deduction_amount, final_pay, production_value, target_value"
    )
    .eq("payroll_period_id", periodId);
  if (itemsRes.error || !itemsRes.data) return empty;

  const rows = itemsRes.data as Array<{
    base_wage: number | string;
    bonus_amount: number | string;
    deduction_amount: number | string;
    final_pay: number | string;
    production_value: number | string;
    target_value: number | string;
  }>;

  let baseWage = 0;
  let bonus = 0;
  let deduction = 0;
  let finalPay = 0;
  let production = 0;
  let target = 0;
  for (const r of rows) {
    baseWage += Number(r.base_wage ?? 0);
    bonus += Number(r.bonus_amount ?? 0);
    deduction += Number(r.deduction_amount ?? 0);
    finalPay += Number(r.final_pay ?? 0);
    production += Number(r.production_value ?? 0);
    target += Number(r.target_value ?? 0);
  }
  return {
    branchCode: opts.branchCode ?? null,
    year: opts.year,
    month: opts.month,
    techniciansPaid: rows.length,
    baseWageTotal: baseWage,
    bonusTotal: bonus,
    deductionTotal: deduction,
    finalPayTotal: finalPay,
    productionValueTotal: production,
    targetValueTotal: target,
  };
}

// ---------- Top services --------------------------------------------------

export type TopService = {
  serviceCode: string | null;
  serviceName: string | null;
  orderCount: number;
  revenue: number;
};

/**
 * Top N services for a (branch, window). Reads `orders` directly because
 * the snapshot materialises daily totals, not per-service breakdowns —
 * adding service granularity to the matview is a future enhancement.
 */
export async function fetchTopServices(opts: {
  branchCode?: string | null;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}): Promise<TopService[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const to = opts.toDate ?? new Date().toISOString().slice(0, 10);
  const fromDate =
    opts.fromDate ??
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const limit = Math.min(opts.limit ?? 10, 50);
  let q = admin
    .from("orders")
    .select("service_code, service_name, item_name, price")
    .gte("created_at", `${fromDate}T00:00:00Z`)
    .lte("created_at", `${to}T23:59:59Z`)
    .eq("status", "completed");
  if (opts.branchCode) q = q.eq("branch_id", opts.branchCode);
  const { data, error } = await q.limit(2000);
  if (error || !data) return [];
  const map = new Map<string, TopService>();
  for (const row of data as Array<{
    service_code: string | null;
    service_name: string | null;
    item_name: string | null;
    price: number | string | null;
  }>) {
    const key = row.service_code ?? row.service_name ?? row.item_name ?? "—";
    const cur = map.get(key) ?? {
      serviceCode: row.service_code,
      serviceName: row.service_name ?? row.item_name,
      orderCount: 0,
      revenue: 0,
    };
    cur.orderCount += 1;
    cur.revenue += Number(row.price ?? 0);
    map.set(key, cur);
  }
  return Array.from(map.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

// ---------- Overdue trends ------------------------------------------------

export type OverdueBucket = {
  branchCode: string;
  bucket: "0-3d" | "4-7d" | "8-14d" | "15-30d" | "30d+";
  count: number;
};

/**
 * Group currently-overdue orders into age buckets so the dashboard can
 * render the "how far behind are we?" indicator. "Overdue" = due_date is
 * in the past AND status is not ready-for-pickup/cancelled.
 */
export async function fetchOverdueTrends(opts: {
  branchCode?: string | null;
}): Promise<OverdueBucket[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const today = new Date().toISOString().slice(0, 10);
  let q = admin
    .from("orders")
    .select("branch_id, due_date, status")
    .not("due_date", "is", null)
    .lt("due_date", today)
    .not("status", "in", "(ready-for-pickup,cancelled)")
    .limit(2000);
  if (opts.branchCode) q = q.eq("branch_id", opts.branchCode);
  const { data, error } = await q;
  if (error || !data) return [];

  const buckets = new Map<string, OverdueBucket>();
  const nowMs = Date.now();
  for (const row of data as Array<{
    branch_id: string | null;
    due_date: string;
  }>) {
    const branchCode = row.branch_id ?? "—";
    const ageDays = Math.floor(
      (nowMs - new Date(row.due_date).getTime()) / (1000 * 60 * 60 * 24)
    );
    const bucket: OverdueBucket["bucket"] =
      ageDays <= 3
        ? "0-3d"
        : ageDays <= 7
        ? "4-7d"
        : ageDays <= 14
        ? "8-14d"
        : ageDays <= 30
        ? "15-30d"
        : "30d+";
    const key = `${branchCode}::${bucket}`;
    const cur = buckets.get(key) ?? { branchCode, bucket, count: 0 };
    cur.count += 1;
    buckets.set(key, cur);
  }
  return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
}

// ---------- Customer growth -----------------------------------------------

export type CustomerGrowthPoint = {
  workDate: string;
  newCustomers: number;
};

/**
 * New customer rows per day for a window. Useful for the future growth
 * curve widget — uses the customers.created_at + branch filter.
 */
export async function fetchCustomerGrowth(opts: {
  branchCode?: string | null;
  fromDate?: string;
  toDate?: string;
}): Promise<CustomerGrowthPoint[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const to = opts.toDate ?? new Date().toISOString().slice(0, 10);
  const fromDate =
    opts.fromDate ??
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let q = admin
    .from("customers")
    .select("created_at")
    .gte("created_at", `${fromDate}T00:00:00Z`)
    .lte("created_at", `${to}T23:59:59Z`)
    .limit(5000);
  if (opts.branchCode) q = q.eq("branch_id", opts.branchCode);
  const { data, error } = await q;
  if (error || !data) return [];
  const counts = new Map<string, number>();
  for (const row of data as Array<{ created_at: string }>) {
    const day = row.created_at.slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([workDate, newCustomers]) => ({ workDate, newCustomers }))
    .sort((a, b) => (a.workDate < b.workDate ? -1 : 1));
}

// ---------- Snapshot refresh ----------------------------------------------

export type RefreshSnapshotResult =
  | { ok: true; rows: number }
  | { ok: false; reason: string };

/**
 * Invoke the SECURITY DEFINER refresh function and report row count
 * after. Cheap — the matview itself is the heavy bit; this RPC is one
 * round trip.
 */
export async function refreshDashboardSnapshot(): Promise<RefreshSnapshotResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า" };
  }
  const rpc = await admin.rpc("refresh_dashboard_daily_snapshot");
  if (rpc.error) {
    return { ok: false, reason: rpc.error.message };
  }
  const { count } = await admin
    .from("dashboard_daily_snapshot")
    .select("work_date", { count: "exact", head: true });
  return { ok: true, rows: count ?? 0 };
}
