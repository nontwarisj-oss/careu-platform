// Order line-items — data layer for multi-item repair tickets.
//
// Store Ops Hardening Phase A. One public.orders row is the ticket
// HEADER; public.order_items holds one row per garment/item on it.
//
// Backward-compatible: insertOrderItems degrades gracefully when the
// 20260554 migration has not been applied yet (missing-table error is
// swallowed so order creation never breaks); fetchOrderItems returns []
// in the same situation, and the receipt/detail layer then falls back
// to the header's own legacy item columns.

import type { SupabaseClient } from "@supabase/supabase-js";
import supabase from "@/lib/supabase";

/** One item as produced by the intake form (pre-persistence). */
export type OrderItemInput = {
  category: string | null;
  serviceCode: string | null;
  serviceName: string;
  detail: string | null;
  quantity: number;
  unitPrice: number;
  urgent: boolean;
  urgentFee: number;
  dueDate: string | null;
  assignedTechnicianId: string | null;
  technicianNote: string | null;
  customerNote: string | null;
  imagePaths: string[];
};

/** A persisted public.order_items row. */
export type OrderItemRow = {
  id: string;
  order_id: string;
  branch_id: string | null;
  line_no: number;
  category: string | null;
  service_code: string | null;
  service_name: string;
  detail: string | null;
  quantity: number;
  unit_price: number | string;
  urgent: boolean;
  urgent_fee: number | string;
  line_total: number | string;
  due_date: string | null;
  assigned_technician_id: string | null;
  technician_note: string | null;
  customer_note: string | null;
  image_paths: string[] | null;
  created_at: string;
};

const ORDER_ITEM_COLUMNS =
  "id, order_id, branch_id, line_no, category, service_code, service_name, detail, quantity, unit_price, urgent, urgent_fee, line_total, due_date, assigned_technician_id, technician_note, customer_note, image_paths, created_at";

const isMissingRelation = (msg: string | undefined): boolean =>
  !!msg &&
  /relation .* does not exist|could not find the table|schema cache|does not exist/i.test(
    msg
  );

/** quantity × unitPrice + (urgent ? urgentFee : 0), clamped at 0. */
export function computeLineTotal(item: {
  quantity: number;
  unitPrice: number;
  urgent: boolean;
  urgentFee: number;
}): number {
  const base = Math.max(0, item.quantity) * Math.max(0, item.unitPrice);
  const urgent = item.urgent ? Math.max(0, item.urgentFee) : 0;
  return base + urgent;
}

/** Sum every line's total — the order header's grand total. */
export function sumItemsTotal(items: OrderItemInput[]): number {
  return items.reduce((s, it) => s + computeLineTotal(it), 0);
}

/**
 * Insert the line-items for a freshly-created order. Best-effort: a
 * missing public.order_items table (un-migrated DB) is swallowed so
 * order creation still succeeds as a legacy single-item order.
 */
export async function insertOrderItems(
  orderId: string,
  branchId: string | null,
  items: OrderItemInput[]
): Promise<{ inserted: number; error: string | null }> {
  if (items.length === 0) return { inserted: 0, error: null };

  const payload = items.map((it, i) => ({
    order_id: orderId,
    branch_id: branchId,
    line_no: i + 1,
    category: it.category,
    service_code: it.serviceCode,
    service_name: it.serviceName,
    detail: it.detail,
    quantity: Math.max(1, Math.floor(it.quantity || 1)),
    unit_price: Math.max(0, it.unitPrice || 0),
    urgent: it.urgent,
    urgent_fee: it.urgent ? Math.max(0, it.urgentFee || 0) : 0,
    line_total: computeLineTotal(it),
    due_date: it.dueDate || null,
    assigned_technician_id: it.assignedTechnicianId || null,
    technician_note: it.technicianNote || null,
    customer_note: it.customerNote || null,
    image_paths: it.imagePaths ?? [],
  }));

  const res = await supabase.from("order_items").insert(payload);
  if (res.error) {
    if (isMissingRelation(res.error.message)) {
      return { inserted: 0, error: null };
    }
    return { inserted: 0, error: res.error.message };
  }
  return { inserted: payload.length, error: null };
}

/**
 * Load the line-items for an order, ordered by line_no. Accepts an
 * explicit client so server routes (admin) and client components share
 * one path. Returns [] for a legacy order with no items, or when the
 * table is absent.
 */
export async function fetchOrderItems(
  client: SupabaseClient,
  orderId: string
): Promise<OrderItemRow[]> {
  const res = await client
    .from("order_items")
    .select(ORDER_ITEM_COLUMNS)
    .eq("order_id", orderId)
    .order("line_no", { ascending: true });
  if (res.error || !res.data) return [];
  return res.data as OrderItemRow[];
}

/** Batch variant — items for many orders in one query (operations board). */
export async function fetchOrderItemsForOrders(
  client: SupabaseClient,
  orderIds: string[]
): Promise<Record<string, OrderItemRow[]>> {
  const byOrder: Record<string, OrderItemRow[]> = {};
  if (orderIds.length === 0) return byOrder;
  const res = await client
    .from("order_items")
    .select(ORDER_ITEM_COLUMNS)
    .in("order_id", orderIds)
    .order("line_no", { ascending: true });
  if (res.error || !res.data) return byOrder;
  for (const row of res.data as OrderItemRow[]) {
    (byOrder[row.order_id] ??= []).push(row);
  }
  return byOrder;
}
