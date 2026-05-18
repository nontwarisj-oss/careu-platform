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
  /** Optional branch slug — lets the matcher break ties to the same branch. */
  branchId?: string | null;
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
export function simpleName(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

// ---------- Reusable order → customer matching -----------------------------
//
// Extracted so the CRM "rebuild links" repair route can persist the SAME
// match decision back to orders.customer_id that the display aggregator
// already uses. One matcher → the database stores exactly what the UI shows.

/** Match tiers, strongest signal first. */
export type OrderMatchTier =
  | "id"
  | "order_phone"
  | "embedded_phone"
  | "name"
  | "simple_name";

/** O(1) lookup indexes covering every match dimension. */
export type CustomerMatchIndex = {
  byId: Map<string, CustomerLite>;
  byPhone: Map<string, CustomerLite[]>;
  byNameLower: Map<string, CustomerLite[]>;
  bySimpleName: Map<string, CustomerLite[]>;
};

/** Minimal order shape the matcher needs. */
export type OrderMatchInput = {
  customer_id: string | null;
  customer_name: string | null;
  /** Optional dedicated phone column, when the order row carries one. */
  customer_phone?: string | null;
  /** Branch slug — used to break ties toward a same-branch customer. */
  branch_id?: string | null;
};

export type OrderMatchResult = {
  customer: CustomerLite | null;
  tier: OrderMatchTier | null;
};

function pushCandidate(
  map: Map<string, CustomerLite[]>,
  key: string,
  customer: CustomerLite
): void {
  const list = map.get(key);
  if (list) {
    if (!list.some((c) => c.id === customer.id)) list.push(customer);
  } else {
    map.set(key, [customer]);
  }
}

/**
 * Build the four lookup indexes once for a customer set. Reused by both
 * `aggregateOrdersToCustomers` (display) and the rebuild-links route (DB
 * repair) so a match never differs between what is shown and what is
 * persisted.
 */
export function buildCustomerMatchIndex(
  customers: CustomerLite[]
): CustomerMatchIndex {
  const byId = new Map<string, CustomerLite>();
  const byPhone = new Map<string, CustomerLite[]>();
  const byNameLower = new Map<string, CustomerLite[]>();
  const bySimpleName = new Map<string, CustomerLite[]>();

  for (const c of customers) {
    byId.set(c.id, c);
    const phone =
      (c.normalizedPhone && c.normalizedPhone.trim()) ||
      normalizePhone(c.phone);
    if (phone) pushCandidate(byPhone, phone, c);
    const nameLower = (c.name ?? "").trim().toLowerCase();
    if (nameLower) pushCandidate(byNameLower, nameLower, c);
    const compact = simpleName(c.normalizedName || c.name);
    if (compact) pushCandidate(bySimpleName, compact, c);
  }
  return { byId, byPhone, byNameLower, bySimpleName };
}

/** Pick the best candidate from a key bucket, preferring a same-branch row. */
function pickCandidate(
  candidates: CustomerLite[] | undefined,
  branchId: string | null | undefined
): CustomerLite | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  if (branchId) {
    const sameBranch = candidates.find((c) => c.branchId === branchId);
    if (sameBranch) return sameBranch;
  }
  return candidates[0];
}

/**
 * Resolve a single order to its customer using the match ladder:
 *   1. customer_id FK            2. dedicated phone column
 *   3. phone digits in the name  4. exact lowercased name
 *   5. simple-name (whitespace + punctuation stripped)
 * The first tier that hits wins; when several customers share a key, a
 * same-branch candidate is preferred.
 */
export function matchOrderToCustomer(
  index: CustomerMatchIndex,
  order: OrderMatchInput
): OrderMatchResult {
  // 1. The real FK — strongest signal.
  if (order.customer_id) {
    const hit = index.byId.get(order.customer_id);
    if (hit) return { customer: hit, tier: "id" };
  }
  // 2. Dedicated phone column on the order, when present.
  if (order.customer_phone) {
    const phone = normalizePhone(order.customer_phone);
    if (phone.length >= 9) {
      const hit = pickCandidate(index.byPhone.get(phone), order.branch_id);
      if (hit) return { customer: hit, tier: "order_phone" };
    }
  }
  // 3. Phone digits embedded in the name cell (legacy sheet rows).
  if (order.customer_name) {
    const embedded = normalizePhone(order.customer_name);
    if (embedded.length >= 9) {
      const hit = pickCandidate(index.byPhone.get(embedded), order.branch_id);
      if (hit) return { customer: hit, tier: "embedded_phone" };
    }
  }
  // 4. Exact lowercased name.
  if (order.customer_name) {
    const nameLower = order.customer_name.trim().toLowerCase();
    if (nameLower) {
      const hit = pickCandidate(
        index.byNameLower.get(nameLower),
        order.branch_id
      );
      if (hit) return { customer: hit, tier: "name" };
    }
  }
  // 5. Simple-name fallback (whitespace + punctuation stripped).
  if (order.customer_name) {
    const compact = simpleName(order.customer_name);
    if (compact) {
      const hit = pickCandidate(
        index.bySimpleName.get(compact),
        order.branch_id
      );
      if (hit) return { customer: hit, tier: "simple_name" };
    }
  }
  return { customer: null, tier: null };
}

/** Why an order is not linked to a customer — surfaced by the resolver. */
export type UnmatchedReason =
  | "null_customer_id"
  | "orphan_customer_id"
  | "no_match"
  | "ambiguous_match";

/**
 * Classify a single order against the customer index. Returns the matched
 * customer when the ladder resolves it (`reason: null`), otherwise the
 * reason it stays unlinked. Shared by the unmatched-orders route so the
 * resolver modal and the /customers warning agree on one definition of
 * "unmatched" — exactly the orders `aggregateOrdersToCustomers` cannot
 * resolve either.
 */
export function classifyUnmatchedOrder(
  index: CustomerMatchIndex,
  order: OrderMatchInput
): { matched: CustomerLite | null; reason: UnmatchedReason | null } {
  const { customer } = matchOrderToCustomer(index, order);
  if (customer) return { matched: customer, reason: null };
  // No customer resolved → describe the most actionable cause.
  const cid =
    typeof order.customer_id === "string" ? order.customer_id.trim() : "";
  if (cid) {
    // customer_id is set but the index has no such customer — a valid id
    // would have matched on tier 1, so this one is orphaned / stale.
    return { matched: null, reason: "orphan_customer_id" };
  }
  const name = (order.customer_name ?? "").trim();
  return { matched: null, reason: name ? "no_match" : "null_customer_id" };
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

  const index = buildCustomerMatchIndex(customers);

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

    // Resolve via the shared match ladder (id → phone → name → simple-name).
    const { customer: target } = matchOrderToCustomer(index, {
      customer_id: order.customer_id,
      customer_name: order.customer_name,
      branch_id: order.branch_id ?? null,
    });
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
