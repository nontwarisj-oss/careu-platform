// Engagement Guardrails — owner-managed safety caps on top of every
// outbound communications path.
//
// Sits ABOVE both Phase 14's per-customer rate limit (which protects
// individual customers from spam) and Phase 16's broadcast feature
// flags (which gate the channel itself). This layer answers the
// franchise-scale question: "could the whole platform go off the
// rails today?" — emergency stop, daily-send ceilings, per-branch
// throttles.
//
// Cached for 60s — same TTL as feature flags. Operators flipping the
// emergency stop see the effect within a minute without redeploy.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const CACHE_TTL_MS = 60 * 1000;

export type GuardrailKey =
  | "global_emergency_stop"
  | "max_sends_per_day_global"
  | "max_sends_per_day_branch"
  | "max_campaigns_per_week_branch"
  | "dry_run_required";

const DEFAULTS: Record<GuardrailKey, unknown> = {
  global_emergency_stop: false,
  max_sends_per_day_global: 5000,
  max_sends_per_day_branch: 1000,
  max_campaigns_per_week_branch: 5,
  dry_run_required: false,
};

type GuardRow = {
  key: string;
  value: unknown;
  branch_id: string | null;
};

type Cache = { loadedAt: number; rows: GuardRow[] };
let cache: Cache | null = null;

async function loadAll(): Promise<GuardRow[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.rows;
  }
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const res = await admin
    .from("engagement_guardrails")
    .select("key, value, branch_id");
  if (res.error || !res.data) return [];
  cache = { loadedAt: Date.now(), rows: res.data as GuardRow[] };
  return cache.rows;
}

export function __resetGuardrailsCache(): void {
  cache = null;
}

async function resolve<T>(
  key: GuardrailKey,
  branchId: string | null,
  fallback: T
): Promise<T> {
  const rows = await loadAll();
  if (branchId) {
    const scoped = rows.find((r) => r.key === key && r.branch_id === branchId);
    if (scoped) return scoped.value as T;
  }
  const global = rows.find((r) => r.key === key && r.branch_id === null);
  if (global) return global.value as T;
  return fallback;
}

// ---------- Public checks -----------------------------------------------

export type GuardrailDecision =
  | { ok: true }
  | { ok: false; bucket: string; reason: string };

/**
 * "Is the global emergency stop on?" Called by every dispatch worker
 * tick + every retention/broadcast send attempt. When true, the
 * caller bails immediately without consuming attempts.
 */
export async function isEmergencyStopped(): Promise<boolean> {
  const v = await resolve<unknown>(
    "global_emergency_stop",
    null,
    DEFAULTS.global_emergency_stop
  );
  return v === true || v === "true";
}

/**
 * "Are we under the global daily send cap?" Counts sends in the last
 * 24h across all channels and branches. Cheap query — uses
 * customer_notifications.sent_at index.
 */
export async function checkGlobalDailySendCap(
  branchId: string | null = null
): Promise<GuardrailDecision> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: true };
  const cap = Number(
    await resolve<number>("max_sends_per_day_global", null, 5000)
  );
  if (!Number.isFinite(cap) || cap <= 0) return { ok: true };
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const r = await admin
    .from("customer_notifications")
    .select("id", { count: "exact", head: true })
    .in("status", ["sent", "delivered"])
    .gte("sent_at", since);
  const count = r.count ?? 0;
  if (count >= cap) {
    return {
      ok: false,
      bucket: "max_sends_per_day_global",
      reason: `global daily cap ${cap} reached (${count} sent in last 24h)`,
    };
  }
  if (branchId) {
    const branchCap = Number(
      await resolve<number>("max_sends_per_day_branch", branchId, 1000)
    );
    if (Number.isFinite(branchCap) && branchCap > 0) {
      const br = await admin
        .from("customer_notifications")
        .select("id", { count: "exact", head: true })
        .in("status", ["sent", "delivered"])
        .gte("sent_at", since)
        .eq("branch_id", branchId);
      const branchCount = br.count ?? 0;
      if (branchCount >= branchCap) {
        return {
          ok: false,
          bucket: "max_sends_per_day_branch",
          reason: `branch ${branchId} daily cap ${branchCap} reached (${branchCount} sent)`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * "Are we under the weekly campaigns-per-branch cap?" Used by the
 * broadcast send API at creation time — refusing a new send_job is
 * friendlier than dead-lettering it mid-flight.
 */
export async function checkWeeklyCampaignCap(
  branchId: string | null
): Promise<GuardrailDecision> {
  if (!branchId) return { ok: true };
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: true };
  const cap = Number(
    await resolve<number>("max_campaigns_per_week_branch", branchId, 5)
  );
  if (!Number.isFinite(cap) || cap <= 0) return { ok: true };
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const r = await admin
    .from("broadcast_send_jobs")
    .select("id", { count: "exact", head: true })
    .eq("branch_id", branchId)
    .gte("created_at", since)
    .in("status", ["queued", "processing", "completed"]);
  const count = r.count ?? 0;
  if (count >= cap) {
    return {
      ok: false,
      bucket: "max_campaigns_per_week_branch",
      reason: `branch ${branchId} weekly campaign cap ${cap} reached (${count} this week)`,
    };
  }
  return { ok: true };
}

/**
 * "Has a dry-run been required + completed for this draft?" Set the
 * guardrail to true and the broadcast API refuses live sends unless
 * a successful dry-run send_job exists for the same draft_id.
 *
 * Returns ok=true when the requirement is disabled OR a prior
 * dry-run exists.
 */
export async function checkDryRunRequirement(opts: {
  draftId: string;
  branchId: string | null;
}): Promise<GuardrailDecision> {
  const required = Boolean(
    await resolve<boolean>("dry_run_required", opts.branchId, false)
  );
  if (!required) return { ok: true };
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: true };
  const r = await admin
    .from("broadcast_send_jobs")
    .select("id", { count: "exact", head: true })
    .eq("draft_id", opts.draftId)
    .eq("mode", "dry_run")
    .eq("status", "completed");
  if ((r.count ?? 0) === 0) {
    return {
      ok: false,
      bucket: "dry_run_required",
      reason:
        "dry-run completion required before live send (per branch / global guardrail)",
    };
  }
  return { ok: true };
}

// ---------- Snapshot for admin UI ----------------------------------------

export async function listGuardrails(): Promise<GuardRow[]> {
  return loadAll();
}

export const GUARDRAIL_KEYS = Object.keys(DEFAULTS) as GuardrailKey[];
export const GUARDRAIL_DEFAULTS = DEFAULTS;
