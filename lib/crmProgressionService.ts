// CRM progression — computes customers.lifecycle_stage + retention_score
// from the existing recency / frequency / spend columns. Sibling to
// lib/customerTierService.ts (which produces customer_tier); the two
// services overlap conceptually but answer different questions:
//
//   • customer_tier = "how valuable is this customer?"
//     (PREMIUM / VIP / REGULAR / INACTIVE)
//   • lifecycle_stage = "where are they in the relationship?"
//     (new / active / at_risk / dormant / reactivated / churned)
//
// A future automation phase reads lifecycle_stage to drive reactivation
// campaigns (at_risk → reminder, dormant → win-back, etc.) without
// re-computing it at the call site.
//
// Server-friendly.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type LifecycleStage =
  | "new"
  | "active"
  | "at_risk"
  | "dormant"
  | "reactivated"
  | "churned";

export const PROGRESSION_THRESHOLDS = {
  /** Days since last visit. Beyond these the stage shifts down. */
  ACTIVE_WITHIN_DAYS: 90,
  AT_RISK_WITHIN_DAYS: 180,
  DORMANT_WITHIN_DAYS: 365,
  // Beyond DORMANT_WITHIN_DAYS → 'churned'.

  /** Minimum order count to count as "active" (vs. one-time 'new'). */
  ACTIVE_MIN_ORDERS: 2,

  /** Retention score weights (sum should equal 1.0 for [0, 100] output). */
  RECENCY_WEIGHT: 0.5,
  FREQUENCY_WEIGHT: 0.3,
  SPEND_WEIGHT: 0.2,
  /** Scale-stops for normalising the inputs. */
  FREQUENCY_CAP: 10, // 10 orders = max frequency score
  SPEND_CAP: 20000, // ฿20k = max spend score
} as const;

export type ProgressionInput = {
  totalOrders: number;
  lifetimeSpend: number;
  lastVisitAt: string | null;
  /** Optional — set when this isn't the customer's first visit to OPS
   *  (i.e. they were `churned` before). Lets the engine emit 'reactivated'
   *  instead of 'active' for a flagging visit. */
  previousLifecycleStage?: LifecycleStage | null;
};

export type ProgressionOutput = {
  lifecycleStage: LifecycleStage;
  retentionScore: number;
};

// ---------- Pure calculation ---------------------------------------------

/**
 * Map (total_orders, last_visit, prior stage) to a lifecycle stage.
 * Rules read top-down — first match wins.
 *
 *   1. 0 orders → 'churned' if we'd previously seen them, else 'new'.
 *   2. Recent (≤ 90 days):
 *        - was previously churned → 'reactivated'
 *        - <2 orders → 'new'
 *        - else → 'active'
 *   3. Recency between 90 and 180 → 'at_risk'.
 *   4. Recency between 180 and 365 → 'dormant'.
 *   5. > 365 → 'churned'.
 */
export function calculateLifecycleStage(input: ProgressionInput): LifecycleStage {
  const t = PROGRESSION_THRESHOLDS;

  if (input.totalOrders === 0) {
    return input.previousLifecycleStage ? "churned" : "new";
  }

  const lastVisitMs = input.lastVisitAt
    ? new Date(input.lastVisitAt).getTime()
    : 0;
  const daysSince = lastVisitMs
    ? (Date.now() - lastVisitMs) / (1000 * 60 * 60 * 24)
    : Infinity;

  if (daysSince <= t.ACTIVE_WITHIN_DAYS) {
    if (input.previousLifecycleStage === "churned" || input.previousLifecycleStage === "dormant") {
      return "reactivated";
    }
    return input.totalOrders >= t.ACTIVE_MIN_ORDERS ? "active" : "new";
  }
  if (daysSince <= t.AT_RISK_WITHIN_DAYS) return "at_risk";
  if (daysSince <= t.DORMANT_WITHIN_DAYS) return "dormant";
  return "churned";
}

/**
 * Retention score in [0, 100]. Pure function over the same inputs as
 * the lifecycle stage. Three components:
 *   • Recency (50 %) — linear from ACTIVE_WITHIN_DAYS down to 0.
 *   • Frequency (30 %) — linear up to FREQUENCY_CAP orders.
 *   • Spend (20 %) — linear up to SPEND_CAP baht.
 *
 * Future tuning: swap the linear curves for log / sigmoid if business
 * decides one big spender shouldn't max the spend axis.
 */
export function calculateRetentionScore(input: ProgressionInput): number {
  const t = PROGRESSION_THRESHOLDS;
  if (input.totalOrders === 0) return 0;
  const lastVisitMs = input.lastVisitAt
    ? new Date(input.lastVisitAt).getTime()
    : 0;
  const daysSince = lastVisitMs
    ? (Date.now() - lastVisitMs) / (1000 * 60 * 60 * 24)
    : Infinity;
  const recency = Math.max(
    0,
    Math.min(
      1,
      (t.ACTIVE_WITHIN_DAYS * 2 - daysSince) / (t.ACTIVE_WITHIN_DAYS * 2)
    )
  );
  const frequency = Math.min(1, input.totalOrders / t.FREQUENCY_CAP);
  const spend = Math.min(1, input.lifetimeSpend / t.SPEND_CAP);
  const score =
    recency * t.RECENCY_WEIGHT +
    frequency * t.FREQUENCY_WEIGHT +
    spend * t.SPEND_WEIGHT;
  return Math.round(score * 10000) / 100; // two decimals
}

// ---------- Read + write ---------------------------------------------------

type CustomerRow = {
  id: string;
  total_orders: number | string | null;
  lifetime_spend: number | string | null;
  last_visit_at: string | null;
  lifecycle_stage: LifecycleStage | null;
};

/**
 * Read one customer's progression columns, compute the next stage +
 * score, and persist. Returns the updated values. Best-effort — silent
 * no-op when the customer doesn't exist (and a structured failure
 * otherwise).
 */
export async function refreshCustomerProgression(
  customerId: string
): Promise<
  | { ok: true; customerId: string; stage: LifecycleStage; score: number }
  | { ok: false; customerId: string; reason: string }
> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      ok: false,
      customerId,
      reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า",
    };
  }
  const fetch = await admin
    .from("customers")
    .select(
      "id, total_orders, lifetime_spend, last_visit_at, lifecycle_stage"
    )
    .eq("id", customerId)
    .maybeSingle();
  if (fetch.error || !fetch.data) {
    return { ok: false, customerId, reason: "ไม่พบลูกค้า" };
  }
  const row = fetch.data as CustomerRow;
  const input: ProgressionInput = {
    totalOrders: Number(row.total_orders ?? 0),
    lifetimeSpend: Number(row.lifetime_spend ?? 0),
    lastVisitAt: row.last_visit_at,
    previousLifecycleStage: row.lifecycle_stage,
  };
  const stage = calculateLifecycleStage(input);
  const score = calculateRetentionScore(input);
  const update = await admin
    .from("customers")
    .update({ lifecycle_stage: stage, retention_score: score })
    .eq("id", customerId);
  if (update.error) {
    return { ok: false, customerId, reason: update.error.message };
  }
  return { ok: true, customerId, stage, score };
}

export type BranchRefreshResult = {
  branchCode: string | null;
  scanned: number;
  updated: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
};

/**
 * Batch refresh every customer in a branch (or every branch when
 * branchCode is null). Capped at 2000 customers per call so a serverless
 * tick never goes over budget; future cron chunks larger workloads.
 */
export async function refreshBranchProgression(
  branchCode: string | null,
  options: { limit?: number } = {}
): Promise<BranchRefreshResult> {
  const startedAt = new Date().toISOString();
  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      branchCode,
      scanned: 0,
      updated: 0,
      failed: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  const limit = Math.min(options.limit ?? 1000, 2000);
  let q = admin.from("customers").select("id").limit(limit);
  if (branchCode) q = q.eq("branch_id", branchCode);
  const { data, error } = await q;
  if (error || !data) {
    return {
      branchCode,
      scanned: 0,
      updated: 0,
      failed: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  let updated = 0;
  let failed = 0;
  for (const row of data as Array<{ id: string }>) {
    const res = await refreshCustomerProgression(row.id);
    if (res.ok) updated += 1;
    else failed += 1;
  }
  return {
    branchCode,
    scanned: data.length,
    updated,
    failed,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
