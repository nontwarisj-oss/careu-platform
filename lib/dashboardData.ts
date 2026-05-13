// Dashboard data fetcher. Single async entry point for "give me everything
// the dashboard needs". Pulls orders + expenses + customer count and applies
// branch scope based on the caller's role.
//
// Today the implementation reads the live tables directly via the bridge JWT
// (so RLS auto-scopes branch-locked users). Tomorrow this can swap to a
// materialised view or pre-aggregated RPC without changing the consumer
// signature — that's the point of the indirection.
//
// Server-friendly: no React imports. Safe to call from a route handler too.

import supabase from "@/lib/supabase";
import { type AnalyticsOrder } from "@/lib/analytics";
import { type ExpenseRow } from "@/lib/expenses";

const WIDE_ORDER_COLUMNS =
  "id, customer_id, price, status, created_at, branch_id, subtotal, discount, urgent_fee, service_category, service_code, service_name, promotion_code, customer_type, payment_status, due_date, labor_cost, material_cost, assigned_technician_id, production_value, tech";

const NARROW_ORDER_COLUMNS =
  "id, customer_id, price, status, created_at";

const EXPENSE_COLUMNS =
  "id, expense_date, category, description, amount, branch_id, payment_method, notes, created_by, created_at";

export type DashboardScope = {
  /**
   * branches.code (text slug) — matches orders.branch_id / customers.branch_id /
   * expenses.branch_id. Required for branch-scoped roles, ignored for
   * all-branch roles.
   */
  branchCode: string | null;
  /** True when caller's role has all_branches=true (owner / hq_admin). */
  allBranches: boolean;
};

export type DashboardSnapshot = {
  orders: AnalyticsOrder[];
  expenses: ExpenseRow[];
  customerCount: number;
  /** ISO timestamp captured at fetch start — useful for "data as of" labels. */
  fetchedAt: string;
  /** First non-null error from any sub-fetch. Lets the page show one banner. */
  error: string | null;
  /** Which column projection the orders query landed on. Diagnostic. */
  ordersProjection: "wide" | "narrow";
};

function mapOrderRow(row: Record<string, unknown>): AnalyticsOrder {
  return {
    id: String(row.id),
    customer_id: (row.customer_id as string) ?? null,
    price: Number(row.price ?? 0),
    status: (row.status as string) ?? "",
    created_at: (row.created_at as string) ?? new Date().toISOString(),
    branch_id: (row.branch_id as string) ?? null,
    subtotal:
      row.subtotal !== null && row.subtotal !== undefined
        ? Number(row.subtotal)
        : null,
    discount: Number(row.discount ?? 0),
    urgent_fee: Number(row.urgent_fee ?? 0),
    service_category: (row.service_category as string) ?? null,
    service_code: (row.service_code as string) ?? null,
    service_name: (row.service_name as string) ?? null,
    promotion_code: (row.promotion_code as string) ?? null,
    customer_type: (row.customer_type as string) ?? null,
    payment_status: (row.payment_status as string) ?? "unpaid",
    due_date: (row.due_date as string) ?? null,
    labor_cost:
      row.labor_cost !== null && row.labor_cost !== undefined
        ? Number(row.labor_cost)
        : null,
    material_cost:
      row.material_cost !== null && row.material_cost !== undefined
        ? Number(row.material_cost)
        : null,
    assigned_technician_id: (row.assigned_technician_id as string) ?? null,
    production_value:
      row.production_value !== null && row.production_value !== undefined
        ? Number(row.production_value)
        : null,
    tech: (row.tech as string) ?? null,
  };
}

function mapExpenseRow(row: Record<string, unknown>): ExpenseRow {
  return {
    id: String(row.id),
    expense_date:
      (row.expense_date as string) ?? new Date().toISOString().slice(0, 10),
    category: (row.category as string) ?? "other",
    description: (row.description as string) ?? null,
    amount: Number(row.amount ?? 0),
    branch_id: (row.branch_id as string) ?? null,
    payment_method: (row.payment_method as string) ?? null,
    notes: (row.notes as string) ?? null,
    created_by: (row.created_by as string) ?? null,
    created_at:
      (row.created_at as string) ?? new Date().toISOString(),
  };
}

/**
 * Fetch the unified dashboard payload. Branch isolation happens at two
 * layers (defense in depth):
 *   • Server side — RLS on orders / customers / expenses scopes the
 *     branch_manager / front_staff / technician queries automatically.
 *   • Client side — when scope.allBranches=false we ALSO filter the result
 *     by branch_code so the page renders the right subset even if the JWT
 *     bridge isn't configured (preview mode).
 */
export async function fetchDashboardSnapshot(
  scope: DashboardScope
): Promise<DashboardSnapshot> {
  const fetchedAt = new Date().toISOString();
  let error: string | null = null;

  // ---- Orders (with wide → narrow fallback for legacy schemas) -----------
  let ordersProjection: "wide" | "narrow" = "wide";
  let orderRows: Array<Record<string, unknown>> = [];

  const wide = await supabase
    .from("orders")
    .select(WIDE_ORDER_COLUMNS)
    .order("created_at", { ascending: false });
  if (wide.error) {
    const narrow = await supabase
      .from("orders")
      .select(NARROW_ORDER_COLUMNS)
      .order("created_at", { ascending: false });
    if (narrow.error) {
      error = narrow.error.message;
    } else {
      ordersProjection = "narrow";
      orderRows = (narrow.data ?? []) as Array<Record<string, unknown>>;
    }
  } else {
    orderRows = (wide.data ?? []) as Array<Record<string, unknown>>;
  }

  let orders = orderRows.map(mapOrderRow);

  // ---- Expenses ----------------------------------------------------------
  let expenses: ExpenseRow[] = [];
  const expRes = await supabase
    .from("expenses")
    .select(EXPENSE_COLUMNS)
    .order("expense_date", { ascending: false });
  if (!expRes.error && expRes.data) {
    expenses = (expRes.data as Array<Record<string, unknown>>).map(
      mapExpenseRow
    );
  }

  // ---- Customer count ----------------------------------------------------
  let customerCount = 0;
  const custCount = await supabase
    .from("customers")
    .select("id", { count: "exact", head: true });
  if (custCount.error) {
    if (!error) error = custCount.error.message;
  } else {
    customerCount = custCount.count ?? 0;
  }

  // ---- Belt-and-braces branch filter -------------------------------------
  // Even with strict RLS in place we apply the filter here so the dashboard
  // renders correctly during preview mode (no JWT bridge, RLS returns all
  // rows). When the bridge is on, RLS already scoped server-side and this
  // filter is a no-op for branch-locked roles.
  if (!scope.allBranches && scope.branchCode) {
    orders = orders.filter((o) => o.branch_id === scope.branchCode);
    expenses = expenses.filter((e) => e.branch_id === scope.branchCode);
  }

  return {
    orders,
    expenses,
    customerCount,
    fetchedAt,
    error,
    ordersProjection,
  };
}
