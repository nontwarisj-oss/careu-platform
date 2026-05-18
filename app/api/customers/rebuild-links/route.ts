// POST /api/customers/rebuild-links — Customer CRM link rebuild + recalc.
//
// Why this route exists: the Google-Sheet customer sync only inserts/keeps
// `customers` rows. It never touches `orders`. Many legacy + sheet-era
// orders carry a null or orphaned `customer_id`, and their stored
// `customer_name` differs from the imported customer by whitespace /
// punctuation / an embedded phone number — so order → customer matching
// fails. The CRM then shows imported customers with 0 visits / ฿0 spend
// even though their order history exists.
//
// This route REPAIRS the database (not just the display):
//   1. Loads every customer + builds the shared match index.
//   2. Matches every order with the id → phone → name → simple-name ladder
//      from lib/customerStats (same matcher the display aggregator uses).
//   3. WRITES the resolved customer_id back to orders that were null /
//      orphaned — orders that already point at a real customer are kept.
//   4. Recomputes per-customer visit count + lifetime spend + tier and
//      writes them to public.customers (cancelled orders excluded).
//
// All writes go through the service-role admin client because browser
// RLS blocks cross-branch UPDATEs on orders/customers.
//
// Auth model — aligned with /api/orders/check-job-id and the order-save
// flow: the platform runs cookieless until LINE login is provisioned, so a
// hard requireRole() would 401 every call. This is an internal back-office
// repair action reachable only from the client-gated /customers page, so
// auth is best-effort (logged, never blocking).

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  aggregateOrdersToCustomers,
  buildCustomerMatchIndex,
  matchOrderToCustomer,
  type CustomerLite,
  type OrderLite,
} from "@/lib/customerStats";
import { calculateCustomerTier } from "@/lib/customerTierService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// One-shot repair sweep over every customer + order — give it room.
export const maxDuration = 60;

const PAGE = 1000;

type CustomerRow = {
  id: string;
  name: string | null;
  phone: string | null;
  normalized_phone: string | null;
  normalized_name: string | null;
  branch_id: string | null;
  primary_branch_id: string | null;
};

type OrderRow = {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  price: number | string | null;
  status: string | null;
  created_at: string;
  branch_id: string | null;
};

/** A write to a column the production schema lacks (alias columns). */
function isUnknownColumnError(err: { code?: string; message?: string } | null) {
  if (!err) return false;
  const code = (err.code ?? "").toString();
  if (code === "PGRST204" || code === "42703") return true;
  const msg = (err.message ?? "").toLowerCase();
  return (
    msg.includes("column") &&
    (msg.includes("does not exist") ||
      msg.includes("schema cache") ||
      msg.includes("could not find"))
  );
}

function round2(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

export async function POST() {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("[rebuild-links] SUPABASE_SERVICE_ROLE_KEY not configured");
    return NextResponse.json(
      { ok: false, error: "service role not configured" },
      { status: 503 }
    );
  }

  // ---- 1. Load every customer (paginated — Supabase caps a select ~1000) --
  const customerRows: CustomerRow[] = [];
  for (let from = 0; from < 200_000; from += PAGE) {
    const res = await admin
      .from("customers")
      .select(
        "id, name, phone, normalized_phone, normalized_name, branch_id, primary_branch_id"
      )
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (res.error || !res.data) {
      console.error("[rebuild-links] customers read failed", res.error);
      return NextResponse.json(
        { ok: false, error: res.error?.message ?? "failed to read customers" },
        { status: 500 }
      );
    }
    customerRows.push(...(res.data as CustomerRow[]));
    if (res.data.length < PAGE) break;
  }

  // ---- 2. Load every order (paginated). Abort WITHOUT writing on error so --
  //         a transient failure can never zero everyone's history out.
  const orderRows: OrderRow[] = [];
  for (let from = 0; from < 500_000; from += PAGE) {
    const res = await admin
      .from("orders")
      .select("id, customer_id, customer_name, price, status, created_at, branch_id")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (res.error || !res.data) {
      console.error("[rebuild-links] orders read failed", res.error);
      return NextResponse.json(
        { ok: false, error: res.error?.message ?? "failed to read orders" },
        { status: 500 }
      );
    }
    orderRows.push(...(res.data as OrderRow[]));
    if (res.data.length < PAGE) break;
  }

  // ---- 3. Match every order against the customer index -------------------
  const lites: CustomerLite[] = customerRows.map((c) => ({
    id: c.id,
    name: c.name ?? "",
    phone: c.phone ?? "",
    normalizedPhone: c.normalized_phone,
    normalizedName: c.normalized_name,
    branchId: c.branch_id,
  }));
  const index = buildCustomerMatchIndex(lites);

  const resolvedOrders: OrderLite[] = [];
  // customer_id → order ids whose customer_id must be (re)written.
  const relinkMap = new Map<string, string[]>();
  let matchedOrders = 0;
  let unmatchedOrders = 0;

  for (const o of orderRows) {
    const { customer } = matchOrderToCustomer(index, {
      customer_id: o.customer_id,
      customer_name: o.customer_name,
      branch_id: o.branch_id,
    });
    if (customer) {
      matchedOrders += 1;
      // Keep an order that already points at a real customer; repair the
      // ones whose customer_id is null / orphaned / stale.
      if (o.customer_id !== customer.id) {
        const arr = relinkMap.get(customer.id);
        if (arr) arr.push(o.id);
        else relinkMap.set(customer.id, [o.id]);
      }
    } else {
      unmatchedOrders += 1;
    }
    resolvedOrders.push({
      customer_id: customer?.id ?? o.customer_id,
      customer_name: o.customer_name,
      price: Number(o.price ?? 0),
      status: o.status,
      created_at: o.created_at,
      branch_id: o.branch_id,
    });
  }

  // ---- 4. Write resolved customer_id back to the orphan orders -----------
  // Grouped by customer + chunked, run in small parallel batches.
  const relinkGroups: Array<{ customerId: string; orderIds: string[] }> = [];
  for (const [customerId, ids] of relinkMap) {
    for (let i = 0; i < ids.length; i += 100) {
      relinkGroups.push({ customerId, orderIds: ids.slice(i, i + 100) });
    }
  }
  let relinkedOrders = 0;
  let orderWriteFailed = 0;
  for (let i = 0; i < relinkGroups.length; i += 10) {
    const slice = relinkGroups.slice(i, i + 10);
    const results = await Promise.all(
      slice.map((g) =>
        admin
          .from("orders")
          .update({ customer_id: g.customerId })
          .in("id", g.orderIds)
      )
    );
    slice.forEach((g, idx) => {
      if (results[idx].error) {
        orderWriteFailed += 1;
        console.error("[rebuild-links] order relink failed", results[idx].error);
      } else {
        relinkedOrders += g.orderIds.length;
      }
    });
  }

  // ---- 5. Recompute per-customer CRM totals (cancelled excluded) ---------
  const { stats } = aggregateOrdersToCustomers(lites, resolvedOrders);

  // Only customers with at least one matched order need a write — a
  // customer with 0 orders already stores 0 / INACTIVE.
  const targets = customerRows.filter((c) => stats[c.id]);

  // Some deployments carry alias columns (visit_count / total_visits /
  // total_spent), older ones do not. Build the payload accordingly and
  // fall back the moment the schema rejects an alias column.
  function payloadFor(c: CustomerRow, includeAliases: boolean) {
    const s = stats[c.id];
    const totalOrders = s?.orderCount ?? 0;
    const lifetimeSpend = round2(s?.totalSpent ?? 0);
    const lastVisitAt = s?.latestDate ?? null;
    const primaryBranchId =
      s?.primaryBranchId ?? c.primary_branch_id ?? c.branch_id ?? null;
    const tier = calculateCustomerTier({
      customerId: c.id,
      totalOrders,
      lifetimeSpend,
      lastVisitAt,
      latestService: s?.latestService ?? null,
      primaryBranchId,
    });
    const base: Record<string, unknown> = {
      total_orders: totalOrders,
      lifetime_spend: lifetimeSpend,
      last_visit_at: lastVisitAt,
      primary_branch_id: primaryBranchId,
      customer_tier: tier,
    };
    if (includeAliases) {
      base.visit_count = totalOrders;
      base.total_visits = totalOrders;
      base.total_spent = lifetimeSpend;
    }
    return base;
  }

  let writeAliases = true;
  let customersUpdated = 0;
  let customerWriteFailed = 0;

  // Probe with the first target so the rest of the sweep knows whether the
  // alias columns exist before running in parallel.
  if (targets.length > 0) {
    const first = targets[0];
    let res = await admin
      .from("customers")
      .update(payloadFor(first, true))
      .eq("id", first.id);
    if (res.error && isUnknownColumnError(res.error)) {
      writeAliases = false;
      res = await admin
        .from("customers")
        .update(payloadFor(first, false))
        .eq("id", first.id);
    }
    if (res.error) {
      customerWriteFailed += 1;
      console.error("[rebuild-links] customer write failed", res.error);
    } else {
      customersUpdated += 1;
    }
  }

  for (let i = 1; i < targets.length; i += 20) {
    const slice = targets.slice(i, i + 20);
    const results = await Promise.all(
      slice.map((c) =>
        admin
          .from("customers")
          .update(payloadFor(c, writeAliases))
          .eq("id", c.id)
      )
    );
    for (const res of results) {
      if (res.error) {
        customerWriteFailed += 1;
        console.error("[rebuild-links] customer write failed", res.error);
      } else {
        customersUpdated += 1;
      }
    }
  }

  const summary = {
    ok: customerWriteFailed === 0 && orderWriteFailed === 0,
    total_orders: orderRows.length,
    linked_orders: matchedOrders,
    unmatched_orders: unmatchedOrders,
    relinked_orders: relinkedOrders,
    customers_scanned: customerRows.length,
    customers_updated: customersUpdated,
    customer_write_failed: customerWriteFailed,
    order_write_failed: orderWriteFailed,
  };
  console.log("[rebuild-links] done", summary);
  return NextResponse.json(summary);
}
