import { branches } from "@/lib/brandConfig";
import {
  SERVICE_CATEGORIES,
  getServiceByCode,
  type ServiceCategoryKey,
} from "@/lib/pricing";

export type AnalyticsOrder = {
  id: string;
  customer_id: string | null;
  price: number;
  status: string;
  created_at: string;
  branch_id: string | null;
  subtotal: number | null;
  discount: number;
  urgent_fee: number;
  service_category: string | null;
  service_code: string | null;
  service_name: string | null;
  promotion_code: string | null;
  customer_type: string | null;
  payment_status: string | null;
  // Added by 20260521 (jobs) and 20260524 (assignments). Optional so old
  // narrow-projection fetches and pre-migration data still type-check.
  due_date?: string | null;
  labor_cost?: number | null;
  material_cost?: number | null;
  assigned_technician_id?: string | null;
  production_value?: number | null;
  tech?: string | null;
};

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function isToday(iso: string, now: Date = new Date()): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function isThisWeek(iso: string, now: Date = new Date()): boolean {
  const d = new Date(iso);
  const start = startOfDay(now);
  start.setDate(start.getDate() - 6);
  return d >= start && d <= now;
}

export function isThisMonth(iso: string, now: Date = new Date()): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth()
  );
}

export function isThisYear(iso: string, now: Date = new Date()): boolean {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear();
}

export function isLastMonth(iso: string, now: Date = new Date()): boolean {
  const d = new Date(iso);
  const ref = new Date(now);
  ref.setMonth(ref.getMonth() - 1);
  return (
    d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth()
  );
}

export function sumRevenue(orders: AnalyticsOrder[]): number {
  return orders.reduce((s, o) => s + Number(o.price || 0), 0);
}

export function growthPercent(current: number, previous: number): number {
  if (previous <= 0) {
    return current > 0 ? 100 : 0;
  }
  return Math.round(((current - previous) / previous) * 100);
}

export function filterByBranch(
  orders: AnalyticsOrder[],
  branchId: string | null,
  allBranches: boolean
): AnalyticsOrder[] {
  if (allBranches || !branchId) return orders;
  return orders.filter((o) => o.branch_id === branchId);
}

export type BranchAggregate = {
  branchId: string;
  shortLabel: string;
  name: string;
  orderCount: number;
  revenue: number;
  pending: number;
  completed: number;
  unpaid: number;
};

export function aggregateByBranch(
  orders: AnalyticsOrder[]
): BranchAggregate[] {
  return branches.map((b) => {
    const scoped = orders.filter((o) => o.branch_id === b.id);
    return {
      branchId: b.id,
      shortLabel: b.shortLabel,
      name: b.name,
      orderCount: scoped.length,
      revenue: sumRevenue(scoped),
      pending: scoped.filter((o) => o.status === "pending").length,
      completed: scoped.filter((o) => o.status === "completed").length,
      unpaid: scoped.filter(
        (o) => (o.payment_status ?? "unpaid") !== "paid"
      ).length,
    };
  });
}

export type ServiceAggregate = {
  code: string;
  label: string;
  orderCount: number;
  revenue: number;
};

export function aggregateTopServices(
  orders: AnalyticsOrder[],
  limit = 5
): ServiceAggregate[] {
  const map = new Map<string, ServiceAggregate>();
  for (const o of orders) {
    const code = o.service_code ?? "unknown";
    const label =
      o.service_name ??
      getServiceByCode(o.service_code ?? undefined)?.nameTh ??
      "ไม่ระบุบริการ";
    const cur = map.get(code) ?? {
      code,
      label,
      orderCount: 0,
      revenue: 0,
    };
    cur.orderCount += 1;
    cur.revenue += Number(o.price || 0);
    map.set(code, cur);
  }
  return Array.from(map.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

export type CategoryAggregate = {
  code: ServiceCategoryKey | "unknown";
  labelTh: string;
  orderCount: number;
  revenue: number;
};

export function aggregateByCategory(
  orders: AnalyticsOrder[]
): CategoryAggregate[] {
  const map = new Map<string, CategoryAggregate>();
  for (const cat of SERVICE_CATEGORIES) {
    map.set(cat.code, {
      code: cat.code,
      labelTh: cat.labelTh,
      orderCount: 0,
      revenue: 0,
    });
  }
  for (const o of orders) {
    const code = (o.service_category as ServiceCategoryKey) ?? "unknown";
    const entry = map.get(code) ?? {
      code: "unknown" as const,
      labelTh: "ไม่ระบุหมวด",
      orderCount: 0,
      revenue: 0,
    };
    entry.orderCount += 1;
    entry.revenue += Number(o.price || 0);
    map.set(code, entry);
  }
  return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
}

export type CustomerCohort = {
  totalCustomers: number;
  newCustomersThisMonth: number;
  repeatCustomers: number;
};

export function aggregateCustomerCohort(
  orders: AnalyticsOrder[],
  customerCount: number
): CustomerCohort {
  const counts = new Map<string, number>();
  for (const o of orders) {
    if (!o.customer_id) continue;
    counts.set(o.customer_id, (counts.get(o.customer_id) ?? 0) + 1);
  }
  const repeatCustomers = Array.from(counts.values()).filter(
    (c) => c >= 2
  ).length;

  const firstSeen = new Map<string, Date>();
  for (const o of orders) {
    if (!o.customer_id) continue;
    const seen = firstSeen.get(o.customer_id);
    const created = new Date(o.created_at);
    if (!seen || created < seen) firstSeen.set(o.customer_id, created);
  }
  const now = new Date();
  let newCustomersThisMonth = 0;
  for (const seen of firstSeen.values()) {
    if (
      seen.getFullYear() === now.getFullYear() &&
      seen.getMonth() === now.getMonth()
    ) {
      newCustomersThisMonth += 1;
    }
  }

  return {
    totalCustomers: customerCount,
    newCustomersThisMonth,
    repeatCustomers,
  };
}

export type PaymentBuckets = {
  paid: number;
  unpaid: number;
  deposit: number;
  unpaidTotal: number;
};

export function aggregatePayments(orders: AnalyticsOrder[]): PaymentBuckets {
  let paid = 0;
  let unpaid = 0;
  let deposit = 0;
  let unpaidTotal = 0;
  for (const o of orders) {
    const status = o.payment_status ?? "unpaid";
    if (status === "paid") paid += 1;
    else if (status === "deposit") deposit += 1;
    else {
      unpaid += 1;
      unpaidTotal += Number(o.price || 0);
    }
  }
  return { paid, unpaid, deposit, unpaidTotal };
}

/**
 * Cost / profit are best-effort. labor_cost / material_cost / branch expenses
 * default to 0 until staff start filling those in via future UI; profit equals
 * revenue minus whatever we know about so the executive numbers degrade
 * gracefully instead of throwing.
 */
export type ProfitSnapshot = {
  revenue: number;
  laborCost: number;
  materialCost: number;
  branchExpense: number;
  grossProfit: number;
  netProfit: number;
  marginPercent: number;
};

export function computeProfit(
  orders: AnalyticsOrder[],
  costs: { laborCost?: number; materialCost?: number; branchExpense?: number } = {}
): ProfitSnapshot {
  const revenue = sumRevenue(orders);
  const laborCost = Math.max(0, costs.laborCost ?? 0);
  const materialCost = Math.max(0, costs.materialCost ?? 0);
  const branchExpense = Math.max(0, costs.branchExpense ?? 0);
  const grossProfit = revenue - materialCost;
  const netProfit = revenue - laborCost - materialCost - branchExpense;
  const marginPercent =
    revenue > 0 ? Math.round((netProfit / revenue) * 100) : 0;
  return {
    revenue,
    laborCost,
    materialCost,
    branchExpense,
    grossProfit,
    netProfit,
    marginPercent,
  };
}
