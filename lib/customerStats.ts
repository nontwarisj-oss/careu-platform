// Customer CRM aggregation. The "visits = 0 / ฿0" bug came from orders whose
// customer_id no longer matches a customer row (legacy data + the recently
// imported sheet duplicates leave orphan references behind) AND whose stored
// customer_name has minor whitespace/punctuation differences.
//
// Strategy: build lookup indexes (id, normalized phone, exact lower name,
// simple name with whitespace + punctuation stripped) and try them in order
// for every order. The first match wins.
//
// Match order (bug-fix phase — phone first, then name fallback):
//   1. order.customer_id  — the real FK, strongest signal.
//   2. normalized phone digits embedded in order.customer_name — legacy
//      Google-Sheet rows like "John Smith 081-234-5678".
//   3. exact lowercased customer_name.
//   4. simpleName (whitespace + punctuation stripped) — "Mr. John Smith "
//      vs "John Smith".
//
// Cancelled / invalid orders are excluded from visit + spend totals so a
// voided ticket never inflates a customer's history.

import { normalizePhone } from "@/lib/phone";

/** Order statuses that must NEVER count toward visits or spend. */
export const EXCLUDED_ORDER_STATUSES = ["cancelled"] as const;

export type CustomerStats = {
  orderCount: number;
  totalSpent: number;
  latestDate: string | null;
  latestService: string | null;
  /** Branch slug where the customer placed the most orders. */
  primaryBranchId: string | null;
};

export type CustomerLite = {
  id: string;
  name: string;
  phone: string;
  /** Optional precomputed normalized phone (customers.normalized_phone). */
  normalizedPhone?: string | null;
  /** Optional precomputed normalized name (customers.normalized_name). */
  normalizedName?: string | null;
};

export type OrderLite = {
  customer_id: string | null;
  customer_name: string | null;
  /** Net total (post-discount) — `orders.price` in the current schema. */
  price: number;
  /** Optional explicit total column if the schema gains one later. */
  total?: number | null;
  created_at: string;
  service_name?: string | null;
  item_name?: string | null;
  /** orders.status — used to drop cancelled/invalid tickets. */
  status?: string | null;
  /** orders.branch_id — used to derive the customer's primary branch. */
  branch_id?: string | null;
};

export type AggregateOptions = {
  /** Statuses excluded from totals. Defaults to EXCLUDED_ORDER_STATUSES. */
  excludeStatuses?: readonly string[];
};

export type AggregationResult = {
  stats: Record<string, CustomerStats>;
  unmatchedOrders: number;
  totalOrders: number;
  /** Orders dropped because their status was excluded (cancelled etc.). */
  excludedOrders: number;
};

function emptyStats(): CustomerStats {
  return {
    orderCount: 0,
    totalSpent: 0,
    latestDate: null,
    latestService: null,
    primaryBranchId: null,
  };
}

/** Collapse to lowercased letters/digits only — strips spaces, punctuation, honorifics' spacing. */
function simpleName(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * Build a `customerId → CustomerStats` map.
 *
 *   - `totalSpent` prefers `order.total` if present, else `order.price` (the
 *     post-discount net written by createSmartOrder).
 *   - `latestService` follows the newest order, preferring `service_name`
 *     before `item_name`.
 *   - `primaryBranchId` is the branch slug carrying the most matched orders.
 *   - Orders whose status is in `excludeStatuses` (cancelled by default) are
 *     dropped before aggregation — they never inflate visits or spend.
 *
 * Returns `unmatchedOrders` so the UI can surface "N orders not linked yet"
 * instead of silently zeroing those customers out.
 */
export function aggregateOrdersToCustomers(
  customers: CustomerLite[],
  orders: OrderLite[],
  options: AggregateOptions = {}
): AggregationResult {
  const excluded = new Set(
    (options.excludeStatuses ?? EXCLUDED_ORDER_STATUSES).map((s) =>
      s.toLowerCase()
    )
  );

  const byId = new Map<string, CustomerLite>();
  const byPhone = new Map<string, CustomerLite>();
  const byNameLower = new Map<string, CustomerLite>();
  const bySimpleName = new Map<string, CustomerLite>();

  for (const c of customers) {
    byId.set(c.id, c);
    const phone =
      (c.normalizedPhone && c.normalizedPhone.trim()) ||
      normalizePhone(c.phone);
    if (phone && !byPhone.has(phone)) byPhone.set(phone, c);
    const nameLower = (c.name ?? "").trim().toLowerCase();
    if (nameLower && !byNameLower.has(nameLower)) byNameLower.set(nameLower, c);
    const compact = simpleName(c.normalizedName || c.name);
    if (compact && !bySimpleName.has(compact)) bySimpleName.set(compact, c);
  }

  const stats: Record<string, CustomerStats> = {};
  const branchTally: Record<string, Map<string, number>> = {};
  let unmatchedOrders = 0;
  let excludedOrders = 0;

  for (const order of orders) {
    // Drop cancelled / invalid tickets before they touch any total.
    if (order.status && excluded.has(order.status.toLowerCase())) {
      excludedOrders += 1;
      continue;
    }

    let target: CustomerLite | undefined;

    // 1. The real FK.
    if (order.customer_id) {
      target = byId.get(order.customer_id);
    }
    // 2. Phone digits embedded in the name cell (legacy sheet rows).
    if (!target && order.customer_name) {
      const embeddedPhone = normalizePhone(order.customer_name);
      if (embeddedPhone.length >= 9) {
        target = byPhone.get(embeddedPhone);
      }
    }
    // 3. Exact lowercased name.
    if (!target && order.customer_name) {
      const nameLower = order.customer_name.trim().toLowerCase();
      if (nameLower) target = byNameLower.get(nameLower);
    }
    // 4. Simple-name fallback (whitespace + punctuation stripped).
    if (!target && order.customer_name) {
      const compact = simpleName(order.customer_name);
      if (compact) target = bySimpleName.get(compact);
    }
    if (!target) {
      unmatchedOrders += 1;
      continue;
    }

    const cur = stats[target.id] ?? emptyStats();
    cur.orderCount += 1;
    const amount =
      order.total !== null && order.total !== undefined
        ? Number(order.total)
        : Number(order.price ?? 0);
    cur.totalSpent += Number.isFinite(amount) ? amount : 0;

    const orderTime = new Date(order.created_at).getTime();
    if (
      !cur.latestDate ||
      (Number.isFinite(orderTime) &&
        orderTime > new Date(cur.latestDate).getTime())
    ) {
      cur.latestDate = order.created_at;
      cur.latestService =
        order.service_name ?? order.item_name ?? cur.latestService;
    }

    if (order.branch_id) {
      const tally = branchTally[target.id] ?? new Map<string, number>();
      tally.set(order.branch_id, (tally.get(order.branch_id) ?? 0) + 1);
      branchTally[target.id] = tally;
    }
    stats[target.id] = cur;
  }

  // Resolve primary branch per customer (most-frequent branch).
  for (const [customerId, tally] of Object.entries(branchTally)) {
    let topBranch: string | null = null;
    let topCount = 0;
    for (const [branch, count] of tally) {
      if (count > topCount) {
        topCount = count;
        topBranch = branch;
      }
    }
    if (stats[customerId]) stats[customerId].primaryBranchId = topBranch;
  }

  return {
    stats,
    unmatchedOrders,
    totalOrders: orders.length,
    excludedOrders,
  };
}
