// GET /api/customers/unmatched-orders — the single source of truth for
// "which orders are NOT linked to a customer".
//
// The bug this fixes: the /customers yellow warning counted unmatched
// orders with the id → phone → name aggregator matcher, while the
// resolver modal queried only `orders.customer_id IS NULL`. After a
// Rebuild CRM, orders whose customer_id is orphan/stale (non-null but
// pointing nowhere) still count as unmatched for the aggregator yet are
// invisible to a NULL-only query — so the warning said "11 of 14" while
// the modal said "nothing to resolve".
//
// Both the warning and the modal now call THIS route, and it runs the
// SAME shared matcher (buildCustomerMatchIndex + classifyUnmatchedOrder
// from lib/customerStats) over the service-role view of customers +
// orders. One definition of "unmatched" → the two counts cannot diverge.
//
// Service-role: browser RLS can scope/hide order + customer reads, which
// would itself desync the count. The admin client sees every row.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  buildCustomerMatchIndex,
  classifyUnmatchedOrder,
  type CustomerLite,
  type UnmatchedReason,
} from "@/lib/customerStats";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const PAGE = 1000;

type CustomerRow = {
  id: string;
  name: string | null;
  phone: string | null;
  normalized_phone: string | null;
  normalized_name: string | null;
  branch_id: string | null;
};

type OrderRow = {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  item_name: string | null;
  price: number | string | null;
  status: string | null;
  created_at: string;
  branch_id: string | null;
  job_id: string | null;
};

type UnmatchedOrder = {
  id: string;
  job_id: string | null;
  customer_name: string;
  /** orders has no phone column today — kept in the shape for the future. */
  customer_phone: string | null;
  item_name: string;
  price: number;
  created_at: string;
  branch_id: string | null;
  reason: UnmatchedReason;
};

export async function GET() {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("[unmatched-orders] SUPABASE_SERVICE_ROLE_KEY not configured");
    return NextResponse.json(
      { ok: false, error: "service role not configured" },
      { status: 503 }
    );
  }

  // ---- Load every customer (paginated — Supabase caps a select ~1000) ----
  const customerRows: CustomerRow[] = [];
  for (let from = 0; from < 200_000; from += PAGE) {
    const res = await admin
      .from("customers")
      .select("id, name, phone, normalized_phone, normalized_name, branch_id")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (res.error || !res.data) {
      console.error("[unmatched-orders] customers read failed", res.error);
      return NextResponse.json(
        { ok: false, error: res.error?.message ?? "failed to read customers" },
        { status: 500 }
      );
    }
    customerRows.push(...(res.data as CustomerRow[]));
    if (res.data.length < PAGE) break;
  }

  // ---- Load every order (paginated) -------------------------------------
  const orderRows: OrderRow[] = [];
  for (let from = 0; from < 500_000; from += PAGE) {
    const res = await admin
      .from("orders")
      .select(
        "id, customer_id, customer_name, item_name, price, status, created_at, branch_id, job_id"
      )
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (res.error || !res.data) {
      console.error("[unmatched-orders] orders read failed", res.error);
      return NextResponse.json(
        { ok: false, error: res.error?.message ?? "failed to read orders" },
        { status: 500 }
      );
    }
    orderRows.push(...(res.data as OrderRow[]));
    if (res.data.length < PAGE) break;
  }

  // ---- Classify every order with the shared matcher ----------------------
  const lites: CustomerLite[] = customerRows.map((c) => ({
    id: c.id,
    name: c.name ?? "",
    phone: c.phone ?? "",
    normalizedPhone: c.normalized_phone,
    normalizedName: c.normalized_name,
    branchId: c.branch_id,
  }));
  const index = buildCustomerMatchIndex(lites);

  const unmatched: UnmatchedOrder[] = [];
  for (const o of orderRows) {
    // Cancelled tickets never count toward visits/spend, so the warning's
    // aggregator skips them — the resolver must skip them too.
    if (o.status && o.status.toLowerCase() === "cancelled") continue;

    const { reason } = classifyUnmatchedOrder(index, {
      customer_id: o.customer_id,
      customer_name: o.customer_name,
      branch_id: o.branch_id,
    });
    if (!reason) continue;

    unmatched.push({
      id: String(o.id),
      job_id: o.job_id ?? null,
      customer_name: o.customer_name ?? "",
      customer_phone: null,
      item_name: o.item_name ?? "",
      price: Number(o.price ?? 0),
      created_at: o.created_at,
      branch_id: o.branch_id ?? null,
      reason,
    });
  }

  const body = {
    ok: true,
    total_orders: orderRows.length,
    unmatched_count: unmatched.length,
    orders: unmatched,
  };
  console.log("[unmatched-orders]", {
    total_orders: body.total_orders,
    unmatched_count: body.unmatched_count,
  });
  return NextResponse.json(body);
}
