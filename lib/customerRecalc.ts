// Customer stats recalculation — the SAFE recalculation helper.
//
// Bug-fix phase. The persisted CRM columns on public.customers
// (total_orders, lifetime_spend, last_visit_at, latest_service,
// customer_tier, primary_branch_id) were maintained by a writer that
// matched orders ONLY by customer_id. Legacy + sheet-imported orders
// often carry a null/stale customer_id, so long-standing customers were
// stored with 0 orders → classified INACTIVE / shown as "new".
//
// This helper recomputes those columns from the order history using the
// robust matcher in lib/customerStats (id → phone → name → simple-name)
// and EXCLUDES cancelled orders from visits + spend.
//
// Safety properties:
//   • Read-only on `orders` — never mutates a ticket.
//   • Aborts without writing anything if the orders read fails, so a
//     transient error can never zero every customer's history.
//   • Writes via the service-role admin client (bypasses RLS uniformly
//     so a cross-branch recalc Just Works).
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  aggregateOrdersToCustomers,
  type CustomerLite,
  type OrderLite,
} from "@/lib/customerStats";
import { calculateCustomerTier } from "@/lib/customerTierService";

export type RecalcResult = {
  ok: boolean;
  customersScanned: number;
  ordersScanned: number;
  updated: number;
  failed: number;
  unmatchedOrders: number;
  excludedOrders: number;
  startedAt: string;
  finishedAt: string;
  reason?: string;
};

type CustomerRow = {
  id: string;
  name: string;
  phone: string | null;
  normalized_phone: string | null;
  normalized_name: string | null;
  branch_id: string | null;
};

type OrderRow = {
  customer_id: string | null;
  customer_name: string | null;
  price: number | string | null;
  status: string | null;
  created_at: string;
  service_name: string | null;
  item_name: string | null;
  branch_id: string | null;
};

function done(
  partial: Omit<RecalcResult, "finishedAt">
): RecalcResult {
  return { ...partial, finishedAt: new Date().toISOString() };
}

/**
 * Recompute visit count + lifetime spend + tier for every customer (or
 * one branch when `branchCode` is set). Returns counts for the caller to
 * surface in a toast / cron heartbeat.
 */
export async function recalcCustomerStats(
  branchCode: string | null = null,
  options: { limit?: number } = {}
): Promise<RecalcResult> {
  const startedAt = new Date().toISOString();
  const base = {
    ok: false,
    customersScanned: 0,
    ordersScanned: 0,
    updated: 0,
    failed: 0,
    unmatchedOrders: 0,
    excludedOrders: 0,
    startedAt,
  };

  const admin = getSupabaseAdmin();
  if (!admin) {
    return done({ ...base, reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า" });
  }

  const cap = Math.min(options.limit ?? 20000, 100000);
  const PAGE = 1000;

  // ---- Load customers (paginated — Supabase caps a select at ~1000) ------
  const customerRows: CustomerRow[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    let cq = admin
      .from("customers")
      .select("id, name, phone, normalized_phone, normalized_name, branch_id")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (branchCode) cq = cq.eq("branch_id", branchCode);
    const custRes = await cq;
    if (custRes.error || !custRes.data) {
      return done({
        ...base,
        reason: custRes.error?.message ?? "ไม่สามารถอ่านตาราง customers",
      });
    }
    customerRows.push(...(custRes.data as CustomerRow[]));
    if (custRes.data.length < PAGE) break;
  }

  // ---- Load orders ------------------------------------------------------
  // Paginated — Supabase caps a single select at ~1000 rows, and a busy
  // shop has far more orders than that. Reading only the first page would
  // undercount visits + spend (the bug being fixed). Abort on error
  // WITHOUT writing — a transient failure must never zero everyone out.
  const orderRows: OrderRow[] = [];
  for (let from = 0; from < 500_000; from += PAGE) {
    const ordRes = await admin
      .from("orders")
      .select(
        "customer_id, customer_name, price, status, created_at, service_name, item_name, branch_id"
      )
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (ordRes.error || !ordRes.data) {
      return done({
        ...base,
        customersScanned: customerRows.length,
        reason: ordRes.error?.message ?? "ไม่สามารถอ่านตาราง orders",
      });
    }
    orderRows.push(...(ordRes.data as OrderRow[]));
    if (ordRes.data.length < PAGE) break;
  }

  const customers: CustomerLite[] = customerRows.map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone ?? "",
    normalizedPhone: c.normalized_phone,
    normalizedName: c.normalized_name,
  }));
  const orders: OrderLite[] = orderRows.map((o) => ({
    customer_id: o.customer_id,
    customer_name: o.customer_name,
    price: Number(o.price ?? 0),
    created_at: o.created_at,
    service_name: o.service_name,
    item_name: o.item_name,
    status: o.status,
    branch_id: o.branch_id,
  }));

  const { stats, unmatchedOrders, excludedOrders } = aggregateOrdersToCustomers(
    customers,
    orders
  );

  // ---- Write recomputed columns back -------------------------------------
  let updated = 0;
  let failed = 0;
  for (const c of customerRows) {
    const s = stats[c.id];
    const totalOrders = s?.orderCount ?? 0;
    const lifetimeSpend = s?.totalSpent ?? 0;
    const lastVisitAt = s?.latestDate ?? null;
    const latestService = s?.latestService ?? null;
    const primaryBranchId = s?.primaryBranchId ?? c.branch_id ?? null;

    const tier = calculateCustomerTier({
      customerId: c.id,
      totalOrders,
      lifetimeSpend,
      lastVisitAt,
      latestService,
      primaryBranchId,
    });

    const { error } = await admin
      .from("customers")
      .update({
        total_orders: totalOrders,
        lifetime_spend: lifetimeSpend,
        last_visit_at: lastVisitAt,
        latest_service: latestService,
        primary_branch_id: primaryBranchId,
        customer_tier: tier,
      })
      .eq("id", c.id);
    if (error) failed += 1;
    else updated += 1;
  }

  return done({
    ok: failed === 0,
    customersScanned: customerRows.length,
    ordersScanned: orderRows.length,
    updated,
    failed,
    unmatchedOrders,
    excludedOrders,
    startedAt,
  });
}
