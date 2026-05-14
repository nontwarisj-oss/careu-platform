// Branch Trigger Overrides — per-branch thresholds that the lifecycle
// engine + retention trigger engine + quiet-hours guard consult before
// applying HQ defaults.
//
// Pattern is "specific wins": when a branch row exists for a key,
// it's used. When absent, the HQ default in `DEFAULTS` applies.
//
// Cached for 60 s — same TTL as feature flags — so an operator who
// flips a value sees the effect within a minute without redeploy.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const CACHE_TTL_MS = 60 * 1000;

// HQ defaults. These mirror the constants in:
//   • lib/customerLifecycle.ts  (DORMANT_DAYS, AT_RISK_DAYS, etc.)
//   • lib/retentionTriggerService.ts (NO_VISIT_THRESHOLD,
//                                       DEDUP_WINDOW_DAYS, etc.)
//   • lib/broadcastPolicyService.ts (quiet hours)
//
// Operators set values per branch; the engines call resolveOverride()
// and fall back to these.

export const DEFAULTS: Record<string, number | boolean> = {
  dormant_days: 180,
  at_risk_days: 90,
  overdue_pickup_delay_days: 2,
  retention_cooldown_days: 30,
  vip_reactivation_delay_days: 45,
  max_daily_trigger_sends: 200,
  quiet_hours_start_h: 9,
  quiet_hours_end_h: 19,
  quiet_hours_enforced: true,
};

export type OverrideKey = keyof typeof DEFAULTS | string;

type OverrideRow = {
  branch_id: string;
  key: string;
  value: unknown;
};

type Cache = {
  loadedAt: number;
  rows: OverrideRow[];
};

let cache: Cache | null = null;

async function loadAll(): Promise<OverrideRow[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.rows;
  }
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const res = await admin
    .from("branch_trigger_overrides")
    .select("branch_id, key, value");
  if (res.error || !res.data) return [];
  cache = {
    loadedAt: Date.now(),
    rows: res.data as OverrideRow[],
  };
  return cache.rows;
}

export function __resetBranchOverridesCache(): void {
  cache = null;
}

/**
 * Resolve a single override for a branch. Branch row → DEFAULTS →
 * `fallback` (when DEFAULTS doesn't have the key either). Numbers
 * and booleans coerce predictably.
 */
export async function resolveOverride<T = number | boolean>(opts: {
  branchId: string | null;
  key: OverrideKey;
  /** Caller-supplied fallback used when DEFAULTS doesn't have the
   *  key. Keeps the engines self-documenting. */
  fallback?: T;
}): Promise<T> {
  const rows = await loadAll();
  if (opts.branchId) {
    const hit = rows.find(
      (r) => r.branch_id === opts.branchId && r.key === opts.key
    );
    if (hit) return coerce(hit.value, opts.fallback) as T;
  }
  if (opts.key in DEFAULTS) {
    return DEFAULTS[opts.key as keyof typeof DEFAULTS] as T;
  }
  return opts.fallback as T;
}

/**
 * Resolve a numeric override with safe coercion. Returns the HQ
 * default when the override row is malformed (e.g. someone stored
 * a string).
 */
export async function resolveNumber(opts: {
  branchId: string | null;
  key: OverrideKey;
  fallback?: number;
}): Promise<number> {
  const value = await resolveOverride<unknown>({
    branchId: opts.branchId,
    key: opts.key,
    fallback: opts.fallback,
  });
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return opts.fallback ?? 0;
}

export async function resolveBoolean(opts: {
  branchId: string | null;
  key: OverrideKey;
  fallback?: boolean;
}): Promise<boolean> {
  const value = await resolveOverride<unknown>({
    branchId: opts.branchId,
    key: opts.key,
    fallback: opts.fallback,
  });
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true" || value === "1";
  if (typeof value === "number") return value !== 0;
  return opts.fallback ?? false;
}

function coerce(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) return fallback;
  return value;
}

/** Snapshot for the per-branch settings UI. */
export async function listOverrides(): Promise<OverrideRow[]> {
  return loadAll();
}

/** Used by tests and by the engagement explainability surface. */
export const OVERRIDE_KEYS = Object.keys(DEFAULTS) as OverrideKey[];
