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

// ---------- LINE message log (recovery surface) --------------------------

export type LineMessageLogRow = {
  id: string;
  customer_id: string | null;
  order_id: string | null;
  branch_id: string | null;
  line_user_id: string | null;
  kind: "order_received" | "order_ready" | "pickup_reminder" | "receipt" | "manual" | "test";
  message_text: string | null;
  status: "pending" | "sent" | "failed" | "skipped";
  error_reason: string | null;
  attempts: number;
  sent_at: string | null;
  created_at: string;
};

export type LineMessageLogFilter = {
  status?: LineMessageLogRow["status"];
  kind?: LineMessageLogRow["kind"];
  branchCode?: string | null;
  /** Default 50. Capped at 200 server-side to keep the admin table responsive. */
  limit?: number;
};

/**
 * Read entries from public.line_message_log. RLS scopes the result:
 *   • owner / hq_admin: every branch.
 *   • branch_manager: rows where branch_id = current_user_branch_code().
 *   • everyone else: empty (no read policy).
 */
export async function listLineMessageLog(
  filter: LineMessageLogFilter = {}
): Promise<LineMessageLogRow[]> {
  let q = supabase
    .from("line_message_log")
    .select(
      "id, customer_id, order_id, branch_id, line_user_id, kind, message_text, status, error_reason, attempts, sent_at, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(Math.min(filter.limit ?? 50, 200));

  if (filter.status) q = q.eq("status", filter.status);
  if (filter.kind) q = q.eq("kind", filter.kind);
  if (filter.branchCode) q = q.eq("branch_id", filter.branchCode);

  const { data, error } = await q;
  if (error || !data) return [];
  return data as LineMessageLogRow[];
}

// ---------- Retry LINE send -----------------------------------------------

export type ResendLineResult =
  | { ok: true; status: string }
  | { ok: false; reason: string };

/**
 * Re-trigger a LINE OA send for a failed / skipped row by calling
 * /api/line/send. The route enforces role + branch ownership, so this is
 * safe to expose from the recovery UI.
 *
 * Idempotency: the underlying /api/line/send route writes one
 * line_message_log row per attempt — meaning a retry creates a new log
 * row rather than mutating the failed one. That's intentional: the
 * audit trail keeps every attempt. The caller decides when "enough
 * retries" turns into "mark resolved".
 */
export async function resendLineMessage(
  orderId: string,
  kind: LineMessageLogRow["kind"] = "receipt"
): Promise<ResendLineResult> {
  try {
    const res = await fetch("/api/line/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, kind }),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      reason?: string;
      status?: string;
    };
    if (!res.ok || !json.ok) {
      return { ok: false, reason: json.reason ?? `HTTP ${res.status}` };
    }
    return { ok: true, status: json.status ?? "sent" };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Network error",
    };
  }
}

// ---------- Resolve helpers ----------------------------------------------

/**
 * Mark a sync failure resolved via the gated /api/admin/recovery/resolve
 * route. The route re-checks owner / hq_admin / branch_manager + branch
 * ownership before writing.
 */
export async function resolveSyncFailure(
  failureId: string,
  note?: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetch("/api/admin/recovery/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ failureId, note }),
    });
    const json = (await res.json()) as { ok?: boolean; reason?: string };
    if (!res.ok || !json.ok) {
      return { ok: false, reason: json.reason ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Network error",
    };
  }
}

// ---------- Bulk + worker (client wrappers) ------------------------------

export type RetryItemOutcome = {
  failureId: string;
  kind: SyncFailureRow["kind"];
  targetId: string | null;
  succeeded: boolean;
  dead: boolean;
  pendingRetry: boolean;
  skipped: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

export type RetryTickResult = {
  ok: true;
  actorRole: string;
  scopedBranch: string | null;
  processed: number;
  succeeded: number;
  failed: number;
  dead: number;
  skipped: number;
  items: RetryItemOutcome[];
  startedAt: string;
  finishedAt: string;
};

export type BulkResolveResult = {
  ok: true;
  bulkActionId: string;
  resolved: number;
  skipped: number;
  items: Array<{
    failureId: string;
    ok: boolean;
    reason?: string;
    alreadyResolved?: boolean;
  }>;
};

/**
 * Drain up to `limit` pending failures via the manual worker endpoint.
 * Owner / HQ may pass a branchCode; branch_manager always runs scoped to
 * their own branch (the server enforces this).
 */
export async function runRetryWorker(
  opts: { limit?: number; kinds?: string[]; branchCode?: string | null } = {}
): Promise<RetryTickResult | { ok: false; reason: string }> {
  try {
    const res = await fetch("/api/admin/recovery/run-worker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: opts.limit ?? 25,
        kinds: opts.kinds ?? null,
        branchCode: opts.branchCode ?? null,
      }),
    });
    const json = (await res.json()) as RetryTickResult | { ok: false; reason: string };
    if (!res.ok || !("ok" in json) || json.ok !== true) {
      const reason =
        (json as { reason?: string }).reason ?? `HTTP ${res.status}`;
      return { ok: false, reason };
    }
    return json;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Network error",
    };
  }
}

/**
 * Bulk-mark sync_failures rows as resolved in one call. Up to 100 ids per
 * request. The server stamps every row with a shared `bulkActionId` in
 * payload.jsonb so admins can group them later.
 */
export async function bulkResolveSyncFailures(
  failureIds: string[],
  note?: string
): Promise<BulkResolveResult | { ok: false; reason: string }> {
  try {
    const res = await fetch("/api/admin/recovery/bulk-resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ failureIds, note }),
    });
    const json = (await res.json()) as
      | BulkResolveResult
      | { ok: false; reason: string };
    if (!res.ok || !("ok" in json) || json.ok !== true) {
      const reason =
        (json as { reason?: string }).reason ?? `HTTP ${res.status}`;
      return { ok: false, reason };
    }
    return json;
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
