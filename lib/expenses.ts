// Expense_Log domain model + aggregation helpers, kept independent of any
// React component so server routes / future sync adapters can reuse them.

import { branches } from "@/lib/brandConfig";
import {
  isLastMonth,
  isThisMonth,
  isThisYear,
  isToday,
  sumRevenue,
  type AnalyticsOrder,
} from "@/lib/analytics";

export type ExpenseCategoryKey =
  | "labor"
  | "materials"
  | "travel"
  | "food"
  | "rent"
  | "utilities"
  | "marketing"
  | "equipment_repair"
  | "personal_reimbursement"
  | "other";

export type ExpenseCategory = {
  code: ExpenseCategoryKey;
  labelTh: string;
  labelEn: string;
};

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  { code: "labor", labelTh: "ค่าแรงช่าง", labelEn: "Labor" },
  { code: "materials", labelTh: "ค่าวัสดุ/อุปกรณ์", labelEn: "Materials" },
  { code: "travel", labelTh: "ค่าเดินทาง", labelEn: "Travel" },
  { code: "food", labelTh: "ค่าอาหาร/เครื่องดื่ม", labelEn: "Food & drinks" },
  { code: "rent", labelTh: "ค่าเช่า", labelEn: "Rent" },
  { code: "utilities", labelTh: "ค่าไฟ/น้ำ/อินเทอร์เน็ต", labelEn: "Utilities" },
  { code: "marketing", labelTh: "ค่าการตลาด", labelEn: "Marketing" },
  { code: "equipment_repair", labelTh: "ค่าซ่อมอุปกรณ์", labelEn: "Equipment repair" },
  {
    code: "personal_reimbursement",
    labelTh: "ค่าใช้จ่ายส่วนตัวเบิก",
    labelEn: "Personal reimbursement",
  },
  { code: "other", labelTh: "อื่นๆ", labelEn: "Other" },
];

export type PaymentMethodKey =
  | "cash"
  | "transfer"
  | "credit_card"
  | "promptpay"
  | "petty_cash"
  | "other";

export type PaymentMethod = {
  code: PaymentMethodKey;
  labelTh: string;
};

export const PAYMENT_METHODS: PaymentMethod[] = [
  { code: "cash", labelTh: "เงินสด" },
  { code: "transfer", labelTh: "โอนผ่านธนาคาร" },
  { code: "credit_card", labelTh: "บัตรเครดิต" },
  { code: "promptpay", labelTh: "PromptPay/QR" },
  { code: "petty_cash", labelTh: "เงินสดย่อย" },
  { code: "other", labelTh: "อื่นๆ" },
];

export type ExpenseRow = {
  id: string;
  expense_date: string; // ISO date (YYYY-MM-DD)
  category: string;
  description: string | null;
  amount: number;
  branch_id: string | null;
  payment_method: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

export function getCategoryLabel(code: string | null | undefined): string {
  if (!code) return "อื่นๆ";
  return (
    EXPENSE_CATEGORIES.find((c) => c.code === code)?.labelTh ?? code
  );
}

export function getPaymentMethodLabel(code: string | null | undefined): string {
  if (!code) return "-";
  return PAYMENT_METHODS.find((p) => p.code === code)?.labelTh ?? code;
}

export function sumExpenses(rows: ExpenseRow[]): number {
  return rows.reduce((s, e) => s + Number(e.amount || 0), 0);
}

// ---- Window helpers (match analytics.ts windowing) -----------------------

function dateMatchesIso(iso: string, predicate: (date: string) => boolean): boolean {
  // iso may be 'YYYY-MM-DD' or a full timestamp; the analytics predicates accept
  // anything new Date(...) can parse, so we normalize by appending T00:00 if
  // missing.
  return predicate(iso.includes("T") ? iso : `${iso}T00:00:00`);
}

export function filterTodayExpenses(rows: ExpenseRow[]): ExpenseRow[] {
  return rows.filter((e) => dateMatchesIso(e.expense_date, isToday));
}
export function filterThisMonthExpenses(rows: ExpenseRow[]): ExpenseRow[] {
  return rows.filter((e) => dateMatchesIso(e.expense_date, isThisMonth));
}
export function filterLastMonthExpenses(rows: ExpenseRow[]): ExpenseRow[] {
  return rows.filter((e) => dateMatchesIso(e.expense_date, isLastMonth));
}
export function filterThisYearExpenses(rows: ExpenseRow[]): ExpenseRow[] {
  return rows.filter((e) => dateMatchesIso(e.expense_date, isThisYear));
}

// ---- Aggregations --------------------------------------------------------

export type CategoryExpenseAggregate = {
  code: ExpenseCategoryKey | "unknown";
  labelTh: string;
  count: number;
  total: number;
};

export function aggregateExpensesByCategory(
  rows: ExpenseRow[]
): CategoryExpenseAggregate[] {
  const map = new Map<string, CategoryExpenseAggregate>();
  for (const cat of EXPENSE_CATEGORIES) {
    map.set(cat.code, {
      code: cat.code,
      labelTh: cat.labelTh,
      count: 0,
      total: 0,
    });
  }
  for (const e of rows) {
    const code = (e.category as ExpenseCategoryKey) ?? "unknown";
    const entry =
      map.get(code) ?? {
        code: "unknown" as const,
        labelTh: code || "ไม่ระบุหมวด",
        count: 0,
        total: 0,
      };
    entry.count += 1;
    entry.total += Number(e.amount || 0);
    map.set(code, entry);
  }
  return Array.from(map.values())
    .filter((c) => c.count > 0 || c.code === "other")
    .sort((a, b) => b.total - a.total);
}

export type BranchExpenseAggregate = {
  branchId: string;
  shortLabel: string;
  count: number;
  total: number;
};

export function aggregateExpensesByBranch(
  rows: ExpenseRow[]
): BranchExpenseAggregate[] {
  return branches.map((b) => {
    const scoped = rows.filter((e) => e.branch_id === b.id);
    return {
      branchId: b.id,
      shortLabel: b.shortLabel,
      count: scoped.length,
      total: sumExpenses(scoped),
    };
  });
}

// ---- Profit --------------------------------------------------------------

export type ProfitWindow = {
  label: string;
  revenue: number;
  expense: number;
  netProfit: number;
  marginPercent: number;
};

export function computeProfitWindow(
  label: string,
  orders: AnalyticsOrder[],
  expenses: ExpenseRow[]
): ProfitWindow {
  const revenue = sumRevenue(orders);
  const expense = sumExpenses(expenses);
  const netProfit = revenue - expense;
  const marginPercent =
    revenue > 0 ? Math.round((netProfit / revenue) * 100) : 0;
  return { label, revenue, expense, netProfit, marginPercent };
}

export type BranchProfit = {
  branchId: string;
  shortLabel: string;
  revenue: number;
  expense: number;
  netProfit: number;
  marginPercent: number;
};

export function computeProfitByBranch(
  orders: AnalyticsOrder[],
  expenses: ExpenseRow[]
): BranchProfit[] {
  return branches.map((b) => {
    const scopedOrders = orders.filter((o) => o.branch_id === b.id);
    const scopedExpenses = expenses.filter((e) => e.branch_id === b.id);
    const revenue = sumRevenue(scopedOrders);
    const expense = sumExpenses(scopedExpenses);
    const netProfit = revenue - expense;
    const marginPercent =
      revenue > 0 ? Math.round((netProfit / revenue) * 100) : 0;
    return {
      branchId: b.id,
      shortLabel: b.shortLabel,
      revenue,
      expense,
      netProfit,
      marginPercent,
    };
  });
}
