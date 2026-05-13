// Unified audit writer. One entry point for every "who did what when"
// record the platform persists. Existing flows still write directly to
// public.order_audit_log when convenient — this service is the canonical
// path for new call sites and the obvious place to add cross-table
// concerns (rate limiting, batching, masking) later.
//
// Domain routing:
//   • domain='order'    → public.order_audit_log              (app-written)
//   • domain='pricing'  → public.pricing_audit_logs           (DB trigger; this
//                          service is a no-op for that domain)
//   • domain='expense'  → public.expense_audit_log            (DB trigger; same)
//   • domain='auth'     → reserved for future public.auth_audit_log
//
// Best-effort: errors are swallowed. Audit failures must never crash the
// caller's primary flow.

import supabase from "@/lib/supabase";

export type AuditDomain = "order" | "pricing" | "expense" | "auth";

export type OrderAuditAction =
  | "created"
  | "status_changed"
  | "payment_changed"
  | "cost_updated"
  | "cancelled"
  | "sync_pushed"
  | "assigned"
  | "receipt_regenerated"
  | "sync_failed";

export type AuditEntry = {
  domain: AuditDomain;
  /** Tightly typed for the 'order' domain; free-form for the others. */
  action: OrderAuditAction | string;
  /** Primary identifier of the affected row (orderId / serviceCode / expenseId). */
  targetId: string;
  /** Profile id of the person doing the action. Null is acceptable. */
  actorId?: string | null;
  /** JSON-serialisable before/after for the changed fields. */
  before?: unknown;
  after?: unknown;
  /** Optional human-readable note shown alongside the action. */
  note?: string | null;
};

export async function recordAudit(entry: AuditEntry): Promise<void> {
  switch (entry.domain) {
    case "order":
      await writeOrderAudit(entry);
      return;
    case "pricing":
    case "expense":
      // The pricing_audit_logs / expense_audit_log triggers populate
      // these tables automatically (see 20260523 / 20260526). Calling
      // through this service for those domains is a no-op so the call
      // pattern can stay consistent across domains in future code.
      return;
    case "auth":
      // Reserved for future public.auth_audit_log.
      return;
  }
}

async function writeOrderAudit(entry: AuditEntry): Promise<void> {
  // Tolerant: the order_audit_log table or its action constraint may not
  // be present on an under-migrated DB. Silent on those errors; loud on
  // anything else.
  try {
    const res = await supabase.from("order_audit_log").insert({
      order_id: entry.targetId,
      action: entry.action,
      before_value: stringifyValue(entry.before),
      after_value: stringifyValue(entry.after),
      changed_by: entry.actorId ?? null,
      note: entry.note ?? null,
    });
    if (
      res.error &&
      !/relation .* does not exist|schema cache|column .* does not exist|check constraint/i.test(
        res.error.message
      )
    ) {
      console.warn(
        "[auditService] order_audit_log insert failed",
        res.error.message
      );
    }
  } catch (err) {
    console.warn(
      "[auditService] order_audit_log threw",
      err instanceof Error ? err.message : String(err)
    );
  }
}

function stringifyValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
