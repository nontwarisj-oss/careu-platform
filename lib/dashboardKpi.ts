// Operational KPI helpers. Pure functions over the data returned by
// fetchDashboardSnapshot — no DB calls here. Lives separately from
// lib/analytics.ts so the foundational helpers in that file remain
// pure analytics primitives, while this file owns the dashboard-shaped
// derived numbers + the assembled bundle.
//
// Importer guidance:
//   • A page that needs ONE KPI imports the individual function.
//   • A page that wants the full operational view imports `assembleKpis`
//     and reads the bundle. Cheaper than calling 12 functions in a row.
//
// Server-friendly (no React imports).

import {
  aggregateByBranch,
  aggregateByCategory,
  aggregateCustomerCohort,
  aggregatePayments,
  aggregateTopServices,
  computeProfit,
  filterByBranch,
  growthPercent,
  isLastMonth,
  isThisMonth,
  isThisYear,
  isToday,
  sumRevenue,
  type AnalyticsOrder,
  type BranchAggregate,
  type CategoryAggregate,
  type CustomerCohort,
  type PaymentBuckets,
  type ProfitSnapshot,
  type ServiceAggregate,
} from "@/lib/analytics";
import {
  EXPENSE_CATEGORIES,
  aggregateExpensesByCategory,
  filterThisMonthExpenses,
  sumExpenses,
  type CategoryExpenseAggregate,
  type ExpenseRow,
} from "@/lib/expenses";

// Re-export the analytics primitives so a caller only needs one import.
export {
  sumRevenue,
  growthPercent,
  filterByBranch,
  isToday,
  isThisMonth,
  isLastMonth,
  isThisYear,
  aggregateByBranch,
  aggregateByCategory,
  aggregateTopServices,
  aggregateCustomerCohort,
  aggregatePayments,
  computeProfit,
};

// ---------- Status-based counts ------------------------------------------

export function countByStatus(orders: AnalyticsOrder[], status: string): number {
  return orders.reduce((n, o) => n + (o.status === status ? 1 : 0), 0);
}

export function getPendingOrders(orders: AnalyticsOrder[]): number {
  return countByStatus(orders, "pending");
}

export function getInProgressOrders(orders: AnalyticsOrder[]): number {
  return countByStatus(orders, "in-progress");
}

export function getReadyForPickup(orders: AnalyticsOrder[]): number {
  return countByStatus(orders, "ready-for-pickup");
}

export function getCompletedToday(orders: AnalyticsOrder[]): AnalyticsOrder[] {
  return orders.filter(
    (o) => o.status === "completed" && isToday(o.created_at)
  );
}

// ---------- Sales / revenue ----------------------------------------------

export function getSalesToday(orders: AnalyticsOrder[]): number {
  return sumRevenue(orders.filter((o) => isToday(o.created_at)));
}

export function getSalesThisMonth(orders: AnalyticsOrder[]): number {
  return sumRevenue(orders.filter((o) => isThisMonth(o.created_at)));
}

export function getSalesLastMonth(orders: AnalyticsOrder[]): number {
  return sumRevenue(orders.filter((o) => isLastMonth(o.created_at)));
}

export function getMonthOverMonthGrowth(orders: AnalyticsOrder[]): number {
  return growthPercent(getSalesThisMonth(orders), getSalesLastMonth(orders));
}

// ---------- Overdue / due-soon -------------------------------------------

const TERMINAL_STATUSES = new Set(["completed", "ready-for-pickup", "cancelled"]);

/** Orders past `due_date` that haven't been delivered. */
export function getOverdueJobs(
  orders: AnalyticsOrder[],
  now: Date = new Date()
): AnalyticsOrder[] {
  const today = now.toISOString().slice(0, 10);
  return orders.filter((o) => {
    if (!o.due_date) return false;
    if (TERMINAL_STATUSES.has(o.status)) return false;
    return o.due_date < today;
  });
}

/** Orders whose `due_date` falls within the next N days (default 2). */
export function getDueSoon(
  orders: AnalyticsOrder[],
  days = 2,
  now: Date = new Date()
): AnalyticsOrder[] {
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + days);
  const horizonStr = horizon.toISOString().slice(0, 10);
  return orders.filter((o) => {
    if (!o.due_date) return false;
    if (TERMINAL_STATUSES.has(o.status)) return false;
    return o.due_date >= today && o.due_date <= horizonStr;
  });
}

// ---------- Cost / profit -------------------------------------------------

export function getLaborCostTotal(orders: AnalyticsOrder[]): number {
  return orders.reduce((s, o) => s + Number(o.labor_cost ?? 0), 0);
}

export function getMaterialCostTotal(orders: AnalyticsOrder[]): number {
  return orders.reduce((s, o) => s + Number(o.material_cost ?? 0), 0);
}

/** Best-effort estimated profit over the given orders + expenses window. */
export function getEstimatedProfit(
  orders: AnalyticsOrder[],
  expenses: ExpenseRow[]
): ProfitSnapshot {
  return computeProfit(orders, {
    laborCost: getLaborCostTotal(orders),
    materialCost: getMaterialCostTotal(orders),
    branchExpense: sumExpenses(expenses),
  });
}

// ---------- Technician workload widgets ----------------------------------

export type TechWorkloadRow = {
  technicianId: string;
  totalOrders: number;
  totalValue: number;
  completedToday: number;
  productionToday: number;
};

/**
 * Per-technician operational summary computed from the orders payload.
 * Today reads `assigned_technician_id` + `production_value` (with the
 * usual fallback to `price - material_cost`). Returns one row per tech
 * with at least one assignment in the orders list.
 */
export function getTechnicianWorkload(
  orders: AnalyticsOrder[]
): TechWorkloadRow[] {
  const byTech = new Map<string, TechWorkloadRow>();
  for (const o of orders) {
    const techId = o.assigned_technician_id;
    if (!techId) continue;
    const entry =
      byTech.get(techId) ?? {
        technicianId: techId,
        totalOrders: 0,
        totalValue: 0,
        completedToday: 0,
        productionToday: 0,
      };
    const value =
      o.production_value !== null && o.production_value !== undefined
        ? Number(o.production_value)
        : Math.max(
            0,
            Number(o.price ?? 0) - Number(o.material_cost ?? 0)
          );
    entry.totalOrders += 1;
    entry.totalValue += value;
    if (isToday(o.created_at)) {
      if (o.status === "completed") entry.completedToday += 1;
      entry.productionToday += value;
    }
    byTech.set(techId, entry);
  }
  return Array.from(byTech.values()).sort(
    (a, b) => b.totalValue - a.totalValue
  );
}

// ---------- Expense summary ----------------------------------------------

export type ExpenseSummary = {
  total: number;
  thisMonthTotal: number;
  byCategory: CategoryExpenseAggregate[];
};

export function getExpenseSummary(expenses: ExpenseRow[]): ExpenseSummary {
  return {
    total: sumExpenses(expenses),
    thisMonthTotal: sumExpenses(filterThisMonthExpenses(expenses)),
    byCategory: aggregateExpensesByCategory(expenses),
  };
}

// ---------- Assembled bundle ---------------------------------------------

export type DashboardKpiBundle = {
  // Headlines
  salesToday: number;
  salesThisMonth: number;
  salesLastMonth: number;
  monthOverMonthPct: number;
  customerCount: number;
  // Operational queue
  pendingOrders: number;
  inProgressOrders: number;
  readyForPickup: number;
  completedToday: AnalyticsOrder[];
  overdueJobs: AnalyticsOrder[];
  dueSoon: AnalyticsOrder[];
  // Service / category mix
  topServices: ServiceAggregate[];
  categoryMix: CategoryAggregate[];
  // Money
  payments: PaymentBuckets;
  profit: ProfitSnapshot;
  expenses: ExpenseSummary;
  // Branch + customer
  branches: BranchAggregate[];
  customerCohort: CustomerCohort;
  // Technician
  technicianWorkload: TechWorkloadRow[];
};

/**
 * Build the full KPI bundle from a snapshot. Use this when a page wants
 * "everything"; for one-off widgets call the individual helpers directly.
 *
 * Important: this function does NOT re-fetch. The caller passes already-
 * filtered orders + expenses (typically from fetchDashboardSnapshot).
 */
export function assembleKpis(input: {
  orders: AnalyticsOrder[];
  expenses: ExpenseRow[];
  customerCount: number;
}): DashboardKpiBundle {
  const { orders, expenses, customerCount } = input;
  return {
    salesToday: getSalesToday(orders),
    salesThisMonth: getSalesThisMonth(orders),
    salesLastMonth: getSalesLastMonth(orders),
    monthOverMonthPct: getMonthOverMonthGrowth(orders),
    customerCount,

    pendingOrders: getPendingOrders(orders),
    inProgressOrders: getInProgressOrders(orders),
    readyForPickup: getReadyForPickup(orders),
    completedToday: getCompletedToday(orders),
    overdueJobs: getOverdueJobs(orders),
    dueSoon: getDueSoon(orders),

    topServices: aggregateTopServices(orders, 5),
    categoryMix: aggregateByCategory(orders),

    payments: aggregatePayments(orders),
    profit: getEstimatedProfit(orders, expenses),
    expenses: getExpenseSummary(expenses),

    branches: aggregateByBranch(orders),
    customerCohort: aggregateCustomerCohort(orders, customerCount),

    technicianWorkload: getTechnicianWorkload(orders),
  };
}

// ---------- Diagnostic: empty bundle for error states --------------------

export function emptyKpiBundle(): DashboardKpiBundle {
  return {
    salesToday: 0,
    salesThisMonth: 0,
    salesLastMonth: 0,
    monthOverMonthPct: 0,
    customerCount: 0,
    pendingOrders: 0,
    inProgressOrders: 0,
    readyForPickup: 0,
    completedToday: [],
    overdueJobs: [],
    dueSoon: [],
    topServices: [],
    categoryMix: [],
    payments: { paid: 0, unpaid: 0, deposit: 0, unpaidTotal: 0 },
    profit: {
      revenue: 0,
      laborCost: 0,
      materialCost: 0,
      branchExpense: 0,
      grossProfit: 0,
      netProfit: 0,
      marginPercent: 0,
    },
    expenses: {
      total: 0,
      thisMonthTotal: 0,
      byCategory: EXPENSE_CATEGORIES.map((c) => ({
        code: c.code,
        labelTh: c.labelTh,
        count: 0,
        total: 0,
      })),
    },
    branches: [],
    customerCohort: {
      totalCustomers: 0,
      newCustomersThisMonth: 0,
      repeatCustomers: 0,
    },
    technicianWorkload: [],
  };
}
