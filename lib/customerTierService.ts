// Customer tier — pure calculation + admin-triggered refresh.
//
// Today's tier vocabulary (subject to tuning as data accumulates):
//
//   REGULAR  — default. Has at least one order; lifetime spend < VIP_THRESHOLD.
//   VIP      — lifetime spend ≥ VIP_THRESHOLD OR order count ≥ VIP_ORDERS.
//   PREMIUM  — lifetime spend ≥ PREMIUM_THRESHOLD AND active in the last
//              PREMIUM_WINDOW_DAYS. Higher bar than VIP and requires
//              recency so we don't keep a one-time big spender at the top.
//   INACTIVE — no orders in the last INACTIVE_AFTER_DAYS days. Wins over
//              every other tier — we'd rather mark a former VIP inactive
//              than keep promoting them as VIP after a year of silence.
//
// Why not a DB trigger today: trigger-based maintenance is doable (we already
// trigger expense_audit_log / pricing_audit_logs) but tier recompute on every
// orders insert/update would couple two unrelated write paths and complicate
// migrations. The foundation phase ships a manual + admin-batch refresh; a
// cron schedule is the obvious next step.
//
// Server-friendly (no React imports). Reads via the service-role admin
// client so reconciling cross-branch numbers as owner / hq_admin Just Works.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// ---------- Thresholds ----------------------------------------------------

export const TIER_THRESHOLDS = {
  VIP_LIFETIME_SPEND: 5000,        // ฿
  VIP_ORDER_COUNT: 5,
  PREMIUM_LIFETIME_SPEND: 20000,   // ฿
  PREMIUM_WINDOW_DAYS: 90,         // PREMIUM requires recent activity
  INACTIVE_AFTER_DAYS: 365,        // No order in this window → INACTIVE
} as const;

// ---------- Public types --------------------------------------------------

export type CustomerTier = "REGULAR" | "VIP" | "PREMIUM" | "INACTIVE";

export type CustomerStats = {
  customerId: string;
  /** Total order count where customer_id matches (any status). */
  totalOrders: number;
  /** Sum of `orders.price` across all matching orders. */
  lifetimeSpend: number;
  /** orders.created_at of the most recent matching order, ISO 8601. */
  lastVisitAt: string | null;
  /** Most recent order's service_name (falls back to item_name). */
  latestService: string | null;
  /** Branch slug where the customer placed most of their orders. */
  primaryBranchId: string | null;
};

// ---------- Pure tier calculation -----------------------------------------

/**
 * Pure function over `CustomerStats`. No DB access. Used by the
 * refresh helpers below AND by the `/customers` page's optimistic local
 * tier display so the badge updates without a round trip.
 *
 * The rules read top-down — first match wins:
 *   1. INACTIVE if last visit is older than INACTIVE_AFTER_DAYS or never.
 *   2. PREMIUM if spend ≥ premium threshold AND recent activity within
 *      PREMIUM_WINDOW_DAYS.
 *   3. VIP if spend ≥ VIP threshold OR order count ≥ VIP threshold.
 *   4. REGULAR otherwise.
 */
export function calculateCustomerTier(stats: CustomerStats): CustomerTier {
  if (stats.totalOrders === 0) return "INACTIVE";

  const nowMs = Date.now();
  const lastVisitMs = stats.lastVisitAt
    ? new Date(stats.lastVisitAt).getTime()
    : 0;
  const daysSinceLastVisit = lastVisitMs
    ? (nowMs - lastVisitMs) / (1000 * 60 * 60 * 24)
    : Infinity;

  if (daysSinceLastVisit > TIER_THRESHOLDS.INACTIVE_AFTER_DAYS) {
    return "INACTIVE";
  }

  if (
    stats.lifetimeSpend >= TIER_THRESHOLDS.PREMIUM_LIFETIME_SPEND &&
    daysSinceLastVisit <= TIER_THRESHOLDS.PREMIUM_WINDOW_DAYS
  ) {
    return "PREMIUM";
  }

  if (
    stats.lifetimeSpend >= TIER_THRESHOLDS.VIP_LIFETIME_SPEND ||
    stats.totalOrders >= TIER_THRESHOLDS.VIP_ORDER_COUNT
  ) {
    return "VIP";
  }

  return "REGULAR";
}

// ---------- Stats computation ---------------------------------------------

/**
 * Aggregate the customer's order history. Uses the admin client so an
 * admin route can refresh any branch's customers. The branch_id field is
 * pulled per-order so we can derive primary_branch_id (the branch slug
 * where the customer placed the most orders — used by the
 * "branch affinity" line on the customer page).
 */
export async function computeCustomerStats(
  customerId: string
): Promise<CustomerStats | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from("orders")
    .select("price, created_at, service_name, item_name, branch_id")
    .eq("customer_id", customerId);
  if (error) return null;

  const rows = (data ?? []) as Array<{
    price: number | string | null;
    created_at: string;
    service_name: string | null;
    item_name: string | null;
    branch_id: string | null;
  }>;

  if (rows.length === 0) {
    return {
      customerId,
      totalOrders: 0,
      lifetimeSpend: 0,
      lastVisitAt: null,
      latestService: null,
      primaryBranchId: null,
    };
  }

  let lifetimeSpend = 0;
  let lastVisitAt: string | null = null;
  let latestService: string | null = null;
  const branchCount = new Map<string, number>();

  for (const row of rows) {
    lifetimeSpend += Number(row.price ?? 0);
    if (!lastVisitAt || row.created_at > lastVisitAt) {
      lastVisitAt = row.created_at;
      latestService = row.service_name ?? row.item_name ?? null;
    }
    if (row.branch_id) {
      branchCount.set(row.branch_id, (branchCount.get(row.branch_id) ?? 0) + 1);
    }
  }

  let primaryBranchId: string | null = null;
  let topCount = 0;
  for (const [branch, count] of branchCount) {
    if (count > topCount) {
      topCount = count;
      primaryBranchId = branch;
    }
  }

  return {
    customerId,
    totalOrders: rows.length,
    lifetimeSpend,
    lastVisitAt,
    latestService,
    primaryBranchId,
  };
}

// ---------- Writers -------------------------------------------------------

export type RefreshResult =
  | { ok: true; customerId: string; tier: CustomerTier; stats: CustomerStats }
  | { ok: false; customerId: string; reason: string };

/**
 * Recompute one customer's stats and persist tier + insight columns.
 * Always writes via the admin client — RLS on customers WOULD let an
 * authenticated user UPDATE their own branch's rows, but we want every
 * recompute to bypass the user-by-user filter so cross-branch admins can
 * trigger refreshes uniformly.
 */
export async function refreshCustomerTier(
  customerId: string
): Promise<RefreshResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      ok: false,
      customerId,
      reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า",
    };
  }
  const stats = await computeCustomerStats(customerId);
  if (!stats) {
    return {
      ok: false,
      customerId,
      reason: "ไม่พบลูกค้า หรืออ่าน orders ไม่สำเร็จ",
    };
  }
  const tier = calculateCustomerTier(stats);

  const { error } = await admin
    .from("customers")
    .update({
      customer_tier: tier,
      total_orders: stats.totalOrders,
      lifetime_spend: stats.lifetimeSpend,
      last_visit_at: stats.lastVisitAt,
      latest_service: stats.latestService,
      primary_branch_id: stats.primaryBranchId,
    })
    .eq("id", customerId);
  if (error) {
    return { ok: false, customerId, reason: error.message };
  }
  return { ok: true, customerId, tier, stats };
}

export type BranchRefreshResult = {
  branchCode: string | null;
  customersScanned: number;
  updated: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
};

/**
 * Recompute tiers for every customer in a branch (or all branches when
 * branchCode is null). Hard cap of 2000 customers per call.
 *
 * DEPRECATED (bug-fix phase): this batch path matched orders by
 * customer_id ONLY, so customers whose legacy/sheet-imported orders lost
 * their customer_id were stored with 0 orders and mis-tiered. The admin
 * refresh route + the hourly cron now call `recalcCustomerStats`
 * (lib/customerRecalc.ts), which uses the robust id → phone → name
 * matcher and excludes cancelled orders. Kept only as a fallback.
 */
export async function refreshBranchCustomerTiers(
  branchCode: string | null,
  options: { limit?: number } = {}
): Promise<BranchRefreshResult> {
  const startedAt = new Date().toISOString();
  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      branchCode,
      customersScanned: 0,
      updated: 0,
      failed: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  const limit = Math.min(options.limit ?? 1000, 2000);
  let q = admin.from("customers").select("id").limit(limit);
  if (branchCode) q = q.eq("branch_id", branchCode);
  const { data, error } = await q;
  if (error || !data) {
    return {
      branchCode,
      customersScanned: 0,
      updated: 0,
      failed: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  let updated = 0;
  let failed = 0;
  for (const row of data as Array<{ id: string }>) {
    const res = await refreshCustomerTier(row.id);
    if (res.ok) updated += 1;
    else failed += 1;
  }
  return {
    branchCode,
    customersScanned: data.length,
    updated,
    failed,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
