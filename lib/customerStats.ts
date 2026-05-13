// Customer CRM aggregation. The "visits = 0 / ฿0" bug came from orders whose
// customer_id no longer matches a customer row (legacy data + the recently
// imported sheet duplicates leave orphan references behind) AND whose stored
// customer_name has minor whitespace/punctuation differences.
//
// Strategy: build five lookup indexes (id, normalized phone, exact lower name,
// simple name with all whitespace + punctuation stripped, name with embedded
// phone digits) and try them in order for every order. The first match wins.
//
// `orders` does not carry a phone column, so phone fallback only fires when
// the order's `customer_name` cell happens to contain phone digits (a common
// shape in the legacy Google Sheet rows like "John Smith 081-234-5678").

import { normalizePhone } from "@/lib/phone";

export type CustomerStats = {
  orderCount: number;
  totalSpent: number;
  latestDate: string | null;
  latestService: string | null;
};

export type CustomerLite = {
  id: string;
  name: string;
  phone: string;
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
};

export type AggregationResult = {
  stats: Record<string, CustomerStats>;
  unmatchedOrders: number;
  totalOrders: number;
};

function emptyStats(): CustomerStats {
  return {
    orderCount: 0,
    totalSpent: 0,
    latestDate: null,
    latestService: null,
  };
}

/** Collapse to lowercased letters/digits only — strips spaces, punctuation, honorifics' spacing. */
function simpleName(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * Build a `customerId → CustomerStats` map. Aggregation rules:
 *   - Match by `order.customer_id` first.
 *   - Then by exact lowercased+trimmed `customer_name`.
 *   - Then by `simpleName` (whitespace + punctuation stripped) — handles
 *     legacy rows like "Mr. John Smith " vs "John Smith".
 *   - Then by phone digits found inside `customer_name` — handles rows where
 *     the front-desk crammed phone into the name cell ("John 0812345678").
 *   - `totalSpent` prefers `order.total` if present, else `order.price` (the
 *     post-discount net written by createSmartOrder).
 *   - `latestService` follows the newest order, preferring `service_name`
 *     before `item_name`.
 *
 * Returns `unmatchedOrders` so the UI can surface "N orders not linked yet"
 * instead of silently zeroing those customers out.
 */
export function aggregateOrdersToCustomers(
  customers: CustomerLite[],
  orders: OrderLite[]
): AggregationResult {
  const byId = new Map<string, CustomerLite>();
  const byPhone = new Map<string, CustomerLite>();
  const byNameLower = new Map<string, CustomerLite>();
  const bySimpleName = new Map<string, CustomerLite>();

  for (const c of customers) {
    byId.set(c.id, c);
    const phone = normalizePhone(c.phone);
    if (phone && !byPhone.has(phone)) byPhone.set(phone, c);
    const nameLower = (c.name ?? "").trim().toLowerCase();
    if (nameLower && !byNameLower.has(nameLower)) byNameLower.set(nameLower, c);
    const compact = simpleName(c.name);
    if (compact && !bySimpleName.has(compact)) bySimpleName.set(compact, c);
  }

  const stats: Record<string, CustomerStats> = {};
  let unmatchedOrders = 0;

  for (const order of orders) {
    let target: CustomerLite | undefined;

    if (order.customer_id) {
      target = byId.get(order.customer_id);
    }
    if (!target && order.customer_name) {
      const nameLower = order.customer_name.trim().toLowerCase();
      if (nameLower) target = byNameLower.get(nameLower);
    }
    if (!target && order.customer_name) {
      const compact = simpleName(order.customer_name);
      if (compact) target = bySimpleName.get(compact);
    }
    if (!target && order.customer_name) {
      // Phone digits embedded inside the name cell (legacy sheet rows).
      const embeddedPhone = normalizePhone(order.customer_name);
      if (embeddedPhone.length >= 9) {
        target = byPhone.get(embeddedPhone);
      }
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
    stats[target.id] = cur;
  }

  return { stats, unmatchedOrders, totalOrders: orders.length };
}
