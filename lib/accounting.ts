// Canonical financial API for the CareU platform. Everything dashboards and
// reports compute eventually flows through these four primitives:
//   computeRevenue(orders)
//   computeExpense(expenses)
//   computeProfit(orders, expenses)
//   computeMargin(revenue, profit)
// plus the per-branch aggregate getBranchPerformance().
//
// This file deliberately re-exports / wraps existing helpers in lib/analytics
// and lib/expenses so callers can converge on one import path without us
// duplicating logic. The lower-level files keep their existing exports for
// backwards compatibility.

import { branches } from "@/lib/brandConfig";
import {
  type AnalyticsOrder,
  aggregateByBranch,
  isLastMonth,
  isThisMonth,
  isThisWeek,
  isThisYear,
  isToday,
  sumRevenue,
} from "@/lib/analytics";
import {
  filterLastMonthExpenses,
  filterThisMonthExpenses,
  filterThisYearExpenses,
  filterTodayExpenses,
  sumExpenses,
  type ExpenseRow,
} from "@/lib/expenses";

// ---- Primitives ----------------------------------------------------------

export function computeRevenue(orders: AnalyticsOrder[]): number {
  return sumRevenue(orders);
}

export function computeExpense(expenses: ExpenseRow[]): number {
  return sumExpenses(expenses);
}

export type ProfitSnapshot = {
  revenue: number;
  expense: number;
  /** revenue minus material cost. Falls back to revenue when no cost data. */
  grossProfit: number;
  /** revenue minus all expenses (labor + material + branch). */
  netProfit: number;
  marginPercent: number;
};

/**
 * Roll-up profit numbers. If `orderCosts` is provided we use per-order labor
 * + material to derive gross profit; otherwise grossProfit equals revenue.
 */
export function computeProfit(
  orders: AnalyticsOrder[],
  expenses: ExpenseRow[],
  orderCosts?: { laborCost: number; materialCost: number }
): ProfitSnapshot {
  const revenue = computeRevenue(orders);
  const expense = computeExpense(expenses);
  const material = orderCosts?.materialCost ?? 0;
  const grossProfit = revenue - material;
  const netProfit = revenue - expense - (orderCosts?.laborCost ?? 0) - material;
  const marginPercent = computeMargin(revenue, netProfit);
  return { revenue, expense, grossProfit, netProfit, marginPercent };
}

export function computeMargin(revenue: number, profit: number): number {
  if (revenue <= 0) return 0;
  return Math.round((profit / revenue) * 100);
}

// ---- Time-window helpers -------------------------------------------------

export type FinancialWindow = "today" | "month" | "lastMonth" | "year" | "all";

export function ordersInWindow(
  orders: AnalyticsOrder[],
  window: FinancialWindow
): AnalyticsOrder[] {
  switch (window) {
    case "today":
      return orders.filter((o) => isToday(o.created_at));
    case "month":
      return orders.filter((o) => isThisMonth(o.created_at));
    case "lastMonth":
      return orders.filter((o) => isLastMonth(o.created_at));
    case "year":
      return orders.filter((o) => isThisYear(o.created_at));
    default:
      return orders;
  }
}

export function expensesInWindow(
  expenses: ExpenseRow[],
  window: FinancialWindow
): ExpenseRow[] {
  switch (window) {
    case "today":
      return filterTodayExpenses(expenses);
    case "month":
      return filterThisMonthExpenses(expenses);
    case "lastMonth":
      return filterLastMonthExpenses(expenses);
    case "year":
      return filterThisYearExpenses(expenses);
    default:
      return expenses;
  }
}

// ---- Branch performance --------------------------------------------------

export type BranchPerformance = {
  branchId: string;
  shortLabel: string;
  name: string;
  orderCount: number;
  revenue: number;
  expense: number;
  netProfit: number;
  marginPercent: number;
  /** Ranking marker: 1 = best, last = worst (when more than one branch has data). */
  rank: number;
  isBest: boolean;
  isWorst: boolean;
};

/**
 * Compute per-branch performance and rank by netProfit descending. Branches
 * with zero revenue AND zero expense are still listed so the CFO can spot
 * dormant locations.
 */
export function getBranchPerformance(
  orders: AnalyticsOrder[],
  expenses: ExpenseRow[]
): BranchPerformance[] {
  const revenueByBranch = new Map<string, number>();
  for (const row of aggregateByBranch(orders)) {
    revenueByBranch.set(row.branchId, row.revenue);
  }
  const ordersByBranch = new Map<string, number>();
  for (const row of aggregateByBranch(orders)) {
    ordersByBranch.set(row.branchId, row.orderCount);
  }
  const expenseByBranch = new Map<string, number>();
  for (const e of expenses) {
    if (!e.branch_id) continue;
    expenseByBranch.set(
      e.branch_id,
      (expenseByBranch.get(e.branch_id) ?? 0) + Number(e.amount || 0)
    );
  }

  const baseRows = branches.map((b) => {
    const revenue = revenueByBranch.get(b.id) ?? 0;
    const expense = expenseByBranch.get(b.id) ?? 0;
    const netProfit = revenue - expense;
    return {
      branchId: b.id,
      shortLabel: b.shortLabel,
      name: b.name,
      orderCount: ordersByBranch.get(b.id) ?? 0,
      revenue,
      expense,
      netProfit,
      marginPercent: computeMargin(revenue, netProfit),
    };
  });

  const sorted = [...baseRows].sort((a, b) => b.netProfit - a.netProfit);
  const withRank: BranchPerformance[] = sorted.map((row, index) => ({
    ...row,
    rank: index + 1,
    isBest: false,
    isWorst: false,
  }));
  const active = withRank.filter((b) => b.revenue > 0 || b.expense > 0);
  if (active.length >= 1) {
    active[0].isBest = true;
  }
  if (active.length >= 2) {
    active[active.length - 1].isWorst = true;
  }
  return withRank;
}
