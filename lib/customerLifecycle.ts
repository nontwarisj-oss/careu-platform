// Customer Lifecycle Engine — explainable, branch-aware status
// classifier.
//
// Phase 18 supersedes the Phase 11 `lifecycle_stage` column on
// public.customers with a richer model that includes 'repeat' and
// 'loyal' tiers and ALWAYS carries a human-readable `reason`. The
// old column is kept as a backwards-compatible mirror — the nightly
// aggregator writes both.
//
// Decision tree (top-down — first match wins):
//
//   • churned         — no order in CHURN_DAYS
//   • dormant         — no order in DORMANT_DAYS (less than churn)
//   • at_risk         — no order in AT_RISK_DAYS AND ≥ 3 prior orders
//   • new             — first order < NEW_WINDOW_DAYS ago AND < 2 orders
//   • loyal           — ≥ LOYAL_ORDER_THRESHOLD orders AND active in last 90d
//   • repeat          — ≥ 2 orders AND active in last 90d
//   • active          — at least one order ever AND last visit < 90d
//
// Threshold values are tunable via lib/featureFlags.ts (future) —
// for Phase 18 they're constants so unit tests can pin them.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// ---------- Thresholds (Phase 18 defaults, Phase 19 overridable) ------
//
// These exports remain the HQ defaults. Per-branch overrides resolve
// via lib/branchTriggerOverrides — call `classifyLifecycle` with
// an `overrides` argument to apply them.

export const NEW_WINDOW_DAYS = 30;
export const AT_RISK_DAYS = 90;
export const DORMANT_DAYS = 180;
export const CHURN_DAYS = 365;
export const LOYAL_ORDER_THRESHOLD = 8;
export const ACTIVE_RECENCY_DAYS = 90;

export type LifecycleOverrides = {
  /** Override AT_RISK_DAYS. */
  atRiskDays?: number;
  /** Override DORMANT_DAYS. */
  dormantDays?: number;
};

// ---------- Types -------------------------------------------------------

export type LifecycleStatus =
  | "new"
  | "active"
  | "repeat"
  | "loyal"
  | "at_risk"
  | "dormant"
  | "churned";

export type LifecycleInputs = {
  totalOrders: number;
  totalSpend: number;
  /** Days since last_visit_at. null when no visit ever. */
  daysSinceVisit: number | null;
  /** Days since first order — used for the 'new' window. null when
   *  no order ever. */
  daysSinceFirstOrder: number | null;
};

export type LifecycleDecision = {
  status: LifecycleStatus;
  /** Human-readable explanation. Stored on customer_lifecycle_status.reason. */
  reason: string;
  inputs: LifecycleInputs;
};

// ---------- Classifier (pure function) ----------------------------------

/**
 * Pure classifier. No DB calls — easy to unit-test. The aggregator
 * loads inputs once and calls this per customer.
 *
 * Per-branch thresholds: pass `overrides` when the caller has
 * already resolved them via lib/branchTriggerOverrides. Falls back
 * to module-level defaults when absent.
 */
export function classifyLifecycle(
  inputs: LifecycleInputs,
  overrides: LifecycleOverrides = {}
): LifecycleDecision {
  const { totalOrders, daysSinceVisit, daysSinceFirstOrder } = inputs;
  const atRiskDays = overrides.atRiskDays ?? AT_RISK_DAYS;
  const dormantDays = overrides.dormantDays ?? DORMANT_DAYS;

  // Zero-orders customer.
  if (totalOrders === 0) {
    return {
      status: "new",
      reason: "ยังไม่มีออเดอร์ — รอสร้างประวัติ",
      inputs,
    };
  }

  // Churned wins outright — definitely-gone customers.
  if (daysSinceVisit != null && daysSinceVisit > CHURN_DAYS) {
    return {
      status: "churned",
      reason: `ไม่ได้กลับมา ${daysSinceVisit} วัน (>${CHURN_DAYS}) — churn`,
      inputs,
    };
  }
  if (daysSinceVisit != null && daysSinceVisit > dormantDays) {
    return {
      status: "dormant",
      reason: `ไม่ได้กลับมา ${daysSinceVisit} วัน (${dormantDays}–${CHURN_DAYS}) — dormant`,
      inputs,
    };
  }
  // At-risk requires both the recency gap AND a meaningful history;
  // a one-off customer who hasn't come back in 90d is "new+gone",
  // not "at-risk loyal".
  if (
    daysSinceVisit != null &&
    daysSinceVisit > atRiskDays &&
    totalOrders >= 3
  ) {
    return {
      status: "at_risk",
      reason: `${totalOrders} ออเดอร์ และไม่ได้กลับมา ${daysSinceVisit} วัน — at_risk`,
      inputs,
    };
  }

  // 'new' takes precedence over 'active' when the relationship is
  // less than NEW_WINDOW_DAYS old AND the customer has ≤ 1 order.
  if (
    daysSinceFirstOrder != null &&
    daysSinceFirstOrder < NEW_WINDOW_DAYS &&
    totalOrders < 2
  ) {
    return {
      status: "new",
      reason: `เพิ่งสร้างประวัติเมื่อ ${daysSinceFirstOrder} วัน (<${NEW_WINDOW_DAYS}) — new`,
      inputs,
    };
  }

  // From here we know: last visit ≤ AT_RISK_DAYS OR no visit signal
  // available. Bucket by frequency.
  const recentlyActive =
    daysSinceVisit == null
      ? totalOrders > 0
      : daysSinceVisit <= ACTIVE_RECENCY_DAYS;

  if (recentlyActive && totalOrders >= LOYAL_ORDER_THRESHOLD) {
    return {
      status: "loyal",
      reason: `${totalOrders} ออเดอร์ (≥${LOYAL_ORDER_THRESHOLD}) — loyal`,
      inputs,
    };
  }
  if (recentlyActive && totalOrders >= 2) {
    return {
      status: "repeat",
      reason: `${totalOrders} ออเดอร์ และเข้ามาเมื่อ ${daysSinceVisit ?? "?"} วัน — repeat`,
      inputs,
    };
  }
  return {
    status: "active",
    reason: `มีออเดอร์ 1 ครั้ง — active`,
    inputs,
  };
}

// ---------- Persistence helper ------------------------------------------

export type LifecycleUpsertInput = {
  customerId: string;
  decision: LifecycleDecision;
  branchId: string | null;
};

/**
 * Upsert a customer's lifecycle row. Captures `previous_status` +
 * `changed_at` only when the status actually transitions — repeat
 * runs that produce the same status leave changed_at alone.
 *
 * Best-effort: errors are logged not thrown. The aggregator processes
 * thousands of customers per run; one bad row must not stop the rest.
 */
export async function upsertLifecycleStatus(
  input: LifecycleUpsertInput
): Promise<{ ok: boolean; changed: boolean; reason?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, changed: false, reason: "no admin client" };

  const { customerId, decision, branchId } = input;

  // Read previous status to detect transitions.
  const prevRes = await admin
    .from("customer_lifecycle_status")
    .select("status")
    .eq("customer_id", customerId)
    .maybeSingle();
  const prevStatus =
    prevRes.data && typeof (prevRes.data as { status?: unknown }).status === "string"
      ? (prevRes.data as { status: string }).status
      : null;

  const changed = prevStatus !== decision.status;
  const patch: Record<string, unknown> = {
    customer_id: customerId,
    status: decision.status,
    reason: decision.reason,
    total_orders: decision.inputs.totalOrders,
    total_spend: decision.inputs.totalSpend,
    days_since_visit: decision.inputs.daysSinceVisit,
    branch_id: branchId,
    computed_at: new Date().toISOString(),
  };
  if (changed) {
    patch.previous_status = prevStatus;
    patch.changed_at = new Date().toISOString();
  }

  const upd = await admin
    .from("customer_lifecycle_status")
    .upsert(patch, { onConflict: "customer_id" });
  if (upd.error) {
    return { ok: false, changed: false, reason: upd.error.message };
  }

  // Mirror to the Phase 11 column for backwards compat. Best-effort —
  // a missing column on an under-migrated DB shouldn't break us.
  try {
    await admin
      .from("customers")
      .update({ lifecycle_stage: decision.status })
      .eq("id", customerId);
  } catch {
    // ignore
  }

  return { ok: true, changed };
}
