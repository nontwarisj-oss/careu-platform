// Operational recovery scaffolding. The point of this module is to give
// owners + HQ a single import for "the thing went wrong, how do we fix
// it?" operations:
//
//   • rebuildReceiptData(orderId)    — re-derive the receipt object from
//     the live order/customer rows. Useful when the cached UI state got
//     stale or the staff hit "regenerate".
//   • resyncOrderToSheet(orderId)    — explicit re-POST to
//     /api/sync-order-to-sheet (also wired from the document page's
//     "ลองซิงค์ Google Sheet อีกครั้ง" button).
//   • listFailedSyncs / markSyncResolved — read + close entries in
//     public.sync_failures (the durable queue from 20260526).
//
// Today most of these are thin wrappers — the heavy lifting still lives
// in the route handlers / receiptData builder. The point of routing
// through this module is that the future /admin/recovery UI imports one
// path, and the rest of the platform doesn't have to learn N new APIs.
//
// Server-friendly (no React imports).

import supabase from "@/lib/supabase";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { buildReceiptData, type ReceiptData } from "@/lib/receiptData";
import type { DocumentOrder } from "@/lib/customerMessage";

// ---------- Sync failures (queue surface) --------------------------------

export type SyncFailureRow = {
  id: string;
  kind: string;
  target_id: string | null;
  payload: Record<string, unknown>;
  reason: string;
  branch_id: string | null;
  attempts: number;
  status: "pending" | "retrying" | "resolved" | "dead";
  last_attempt_at: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type SyncFailureFilter = {
  status?: SyncFailureRow["status"];
  kind?: SyncFailureRow["kind"];
  branchCode?: string | null;
  limit?: number;
};

/**
 * Read entries from public.sync_failures. RLS limits this to owner /
 * hq_admin out of the box. Branch managers don't see the queue today.
 */
export async function listFailedSyncs(
  filter: SyncFailureFilter = {}
): Promise<SyncFailureRow[]> {
  let q = supabase
    .from("sync_failures")
    .select(
      "id, kind, target_id, payload, reason, branch_id, attempts, status, last_attempt_at, created_at, resolved_at"
    )
    .order("created_at", { ascending: false })
    .limit(filter.limit ?? 50);

  if (filter.status) q = q.eq("status", filter.status);
  if (filter.kind) q = q.eq("kind", filter.kind);
  if (filter.branchCode) q = q.eq("branch_id", filter.branchCode);

  const { data, error } = await q;
  if (error || !data) return [];
  return data as SyncFailureRow[];
}

/**
 * Mark a sync_failures row as resolved. Service-role only — admin client
 * because the table has no UPDATE policy for authenticated users.
 */
export async function markSyncResolved(
  failureId: string,
  note?: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY not configured" };
  }
  const { error } = await admin
    .from("sync_failures")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      payload: note ? { resolutionNote: note } : undefined,
    })
    .eq("id", failureId);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

// ---------- Receipt recovery ---------------------------------------------

/**
 * Re-derive a receipt's ReceiptData from the live DB. Used by the future
 * "regenerate receipt" admin button. Returns null when the order is
 * missing or RLS blocks the read.
 */
export async function rebuildReceiptData(
  orderId: string
): Promise<ReceiptData | null> {
  const ord = await supabase
    .from("orders")
    .select(
      "id, customer_id, customer_name, item_name, price, status, created_at, notes, urgent, urgent_fee, branch_id, subtotal, discount, quantity, service_category, service_code, service_name, template_text, customer_type, promotion_code, payment_status, job_id, due_date, tech"
    )
    .eq("id", orderId)
    .maybeSingle();

  if (ord.error || !ord.data) return null;
  const raw = ord.data as Record<string, unknown>;
  const customerId = (raw.customer_id as string | null) ?? null;

  let phone: string | null = null;
  if (customerId) {
    const cust = await supabase
      .from("customers")
      .select("phone")
      .eq("id", customerId)
      .maybeSingle();
    if (cust.data && (cust.data as { phone?: string }).phone) {
      phone = (cust.data as { phone: string }).phone;
    }
  }

  const documentOrder: DocumentOrder = {
    id: String(raw.id),
    customer_name: (raw.customer_name as string) ?? "",
    customer_phone: phone,
    item_name: (raw.item_name as string) ?? "",
    price: Number(raw.price ?? 0),
    subtotal:
      raw.subtotal !== null && raw.subtotal !== undefined
        ? Number(raw.subtotal)
        : null,
    discount: Number(raw.discount ?? 0),
    urgent: Boolean(raw.urgent),
    urgent_fee: Number(raw.urgent_fee ?? 0),
    quantity: Number(raw.quantity ?? 1),
    status: (raw.status as string) ?? "pending",
    notes: (raw.notes as string) ?? null,
    service_category: (raw.service_category as string) ?? null,
    service_code: (raw.service_code as string) ?? null,
    service_name: (raw.service_name as string) ?? null,
    template_text: (raw.template_text as string) ?? null,
    customer_type: (raw.customer_type as string) ?? null,
    promotion_code: (raw.promotion_code as string) ?? null,
    payment_status: (raw.payment_status as string) ?? "unpaid",
    created_at: (raw.created_at as string) ?? new Date().toISOString(),
  };

  return buildReceiptData({
    order: documentOrder,
    branchId: (raw.branch_id as string | null) ?? null,
    customerPhone: phone,
    jobId: (raw.job_id as string | null) ?? null,
    dueDate: (raw.due_date as string | null) ?? null,
    technicianLabel: (raw.tech as string | null) ?? null,
  });
}

// ---------- Re-sync ------------------------------------------------------

export type ResyncResult =
  | { ok: true; sheet?: string; rowIndex?: number }
  | { ok: false; reason: string };

/**
 * Trigger /api/sync-order-to-sheet for the given order. Caller decides
 * how to expose this — the document page already does it from a button,
 * the future /admin/recovery UI will loop over multiple failed orders.
 */
export async function resyncOrderToSheet(orderId: string): Promise<ResyncResult> {
  try {
    const res = await fetch("/api/sync-order-to-sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId }),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      reason?: string;
      sheet?: string;
      rowIndex?: number;
    };
    if (!res.ok || !json.ok) {
      return { ok: false, reason: json.reason ?? `HTTP ${res.status}` };
    }
    return { ok: true, sheet: json.sheet, rowIndex: json.rowIndex };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Network error",
    };
  }
}

// ---------- KPI rebuild (placeholder) ------------------------------------

/**
 * Future: rebuild materialised KPI summaries (dashboard, technician,
 * branch profit). Today every KPI is computed on the fly client-side,
 * so this is a no-op. The signature is parked here so the future cron
 * job + admin UI can wire it up without inventing the API.
 */
export async function rebuildKpiSummaries(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  return {
    ok: false,
    reason:
      "KPI summaries are computed on the fly — no materialised view to rebuild yet.",
  };
}
