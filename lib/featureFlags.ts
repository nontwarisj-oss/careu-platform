// Feature Flags — server-side toggle service.
//
// Reads from public.feature_flags (key/value/branch_id). Cached per
// serverless-function lifetime so the broadcast worker doesn't hit
// the DB on every customer it processes. The cache TTL is short
// (60 s) so an operator who flips a flag sees the effect quickly
// without redeploying.
//
// Single-branch by default — `enable_cross_branch_broadcasts=false`
// rejects send jobs whose audience spans branches.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const CACHE_TTL_MS = 60 * 1000;

// Hard-coded fall-back defaults — used when the DB is unreachable
// (e.g. cold-start before the table is migrated). These match the
// migration's inserted defaults so a fresh deploy has consistent
// behaviour regardless of which path hits first.
const FALLBACK: Record<string, unknown> = {
  enable_sms: true,
  enable_line_broadcast: true,
  enable_scheduled_broadcasts: true,
  enable_cross_branch_broadcasts: false,
  broadcast_max_targets_per_job: 2000,
  broadcast_quiet_hours_start_h: 9,
  broadcast_quiet_hours_end_h: 19,
  broadcast_dedup_window_hours: 24,
};

type FlagRow = {
  key: string;
  value: unknown;
  branch_id: string | null;
};

type FlagCache = {
  loadedAt: number;
  rows: FlagRow[];
};

let cache: FlagCache | null = null;

async function loadFlags(): Promise<FlagRow[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.rows;
  }
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const res = await admin
    .from("feature_flags")
    .select("key, value, branch_id");
  if (res.error || !res.data) return [];
  cache = {
    loadedAt: Date.now(),
    rows: res.data as FlagRow[],
  };
  return cache.rows;
}

/** Reset the in-memory cache. Test-only. */
export function __resetFeatureFlagsCache(): void {
  cache = null;
}

/**
 * Lookup a flag value. Branch-scoped row wins over the global
 * (branch_id IS NULL) row when both exist. Falls back to the
 * hard-coded default when the table is unreachable or the key is
 * missing.
 */
export async function getFlag<T = unknown>(
  key: string,
  branchId?: string | null
): Promise<T> {
  const rows = await loadFlags();
  const scoped = rows.find((r) => r.key === key && r.branch_id === branchId);
  if (scoped) return scoped.value as T;
  const global = rows.find((r) => r.key === key && r.branch_id === null);
  if (global) return global.value as T;
  return (FALLBACK[key] ?? null) as T;
}

/** Convenience boolean lookup with strict coercion. */
export async function getBoolFlag(
  key: string,
  branchId?: string | null
): Promise<boolean> {
  const value = await getFlag(key, branchId);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true" || value === "1";
  if (typeof value === "number") return value !== 0;
  return false;
}

/** Convenience number lookup with strict coercion. */
export async function getNumberFlag(
  key: string,
  branchId?: string | null
): Promise<number> {
  const value = await getFlag(key, branchId);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  const fb = FALLBACK[key];
  if (typeof fb === "number") return fb;
  return 0;
}

/** Snapshot of all flags + their scope. Used by the admin flags UI. */
export async function listFlags(): Promise<FlagRow[]> {
  return loadFlags();
}

// ---------- Known keys exposed as constants ------------------------------
//
// Catalog at one glance — drift between code and DB is detectable
// via a smoke test that compares this list to `select key from
// feature_flags where branch_id is null`.

export const FLAG_KEYS = {
  ENABLE_SMS: "enable_sms",
  ENABLE_LINE_BROADCAST: "enable_line_broadcast",
  ENABLE_SCHEDULED_BROADCASTS: "enable_scheduled_broadcasts",
  ENABLE_CROSS_BRANCH_BROADCASTS: "enable_cross_branch_broadcasts",
  BROADCAST_MAX_TARGETS_PER_JOB: "broadcast_max_targets_per_job",
  BROADCAST_QUIET_HOURS_START_H: "broadcast_quiet_hours_start_h",
  BROADCAST_QUIET_HOURS_END_H: "broadcast_quiet_hours_end_h",
  BROADCAST_DEDUP_WINDOW_HOURS: "broadcast_dedup_window_hours",
} as const;
