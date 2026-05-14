// Broadcast Policy Service — the gate that decides whether a specific
// customer + channel within a specific send_job should be dispatched
// right now.
//
// This is the BROADCAST-SPECIFIC analogue of
// lib/communicationPolicyService. The communication policy runs for
// every send (including transactional). This service adds the rules
// that apply ONLY to broadcasts:
//
//   1. Cross-draft dedup — if the customer already received another
//      broadcast in the last N hours (configurable via feature flag),
//      skip them. Newest send wins.
//   2. Quiet hours — broadcasts may only DISPATCH during
//      09:00–19:00 Bangkok by default (flag-configurable).
//   3. Schedule gate — if scheduled_for > now, defer.
//   4. Cross-branch enforcement — if the audience spans branches and
//      the cross-branch flag is off, reject.
//
// Layered with the existing per-customer rate limiter and the
// communicationPolicyService preference gate; this service does NOT
// replace those — it sits in front of them at the FAN-OUT layer.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getBoolFlag,
  getNumberFlag,
  FLAG_KEYS,
} from "@/lib/featureFlags";
import {
  resolveBoolean,
  resolveNumber,
} from "@/lib/branchTriggerOverrides";

// ---------- Quiet hours --------------------------------------------------

const BANGKOK_TZ = "Asia/Bangkok";

/**
 * Bangkok hour-of-day as an integer 0-23. We avoid pulling in a
 * date library — Intl.DateTimeFormat already knows Bangkok via the
 * IANA tz database that ships with Node 22+.
 */
function bangkokHour(now: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: BANGKOK_TZ,
      hour: "numeric",
      hour12: false,
    }).formatToParts(now);
    const h = parts.find((p) => p.type === "hour");
    if (!h) return now.getHours();
    return Number(h.value) % 24;
  } catch {
    // Fall back to server-local time. In containers running in UTC
    // (Vercel default), Bangkok is UTC+7 — adjust manually.
    return (now.getUTCHours() + 7) % 24;
  }
}

export type QuietHoursCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * "Are we within the allowed broadcast window right now?" Used by
 * the broadcast send worker before each tick AND by the retention
 * trigger sweep + lifecycle notifier.
 *
 * Resolution order:
 *   1. Per-branch row in `branch_trigger_overrides`
 *      (quiet_hours_start_h / quiet_hours_end_h / quiet_hours_enforced).
 *   2. Global feature_flags row.
 *   3. Hard-coded fallback (9 → 19).
 *
 * `quiet_hours_enforced=false` (per-branch only) bypasses the gate
 * — a 24/7 emergency-response branch wouldn't sit idle at 4 AM.
 *
 * Returns `ok=true` to allow the send. The reason field on `ok=false`
 * is a sentence the trigger / dispatch surfaces in dispatch_log so
 * operators can see "deferred 02:13 — outside quiet hours" in the
 * dashboard.
 */
export async function checkQuietHours(
  now: Date = new Date(),
  branchId: string | null = null
): Promise<QuietHoursCheck> {
  // Branch can opt OUT of quiet hours entirely. Default true.
  const enforced = await resolveBoolean({
    branchId,
    key: "quiet_hours_enforced",
    fallback: true,
  });
  if (!enforced) return { ok: true };

  // Branch row → global flag → hard-coded default (resolveNumber
  // already chains DEFAULTS for us).
  const startH = await resolveNumber({
    branchId,
    key: "quiet_hours_start_h",
    fallback: await getNumberFlag(FLAG_KEYS.BROADCAST_QUIET_HOURS_START_H),
  });
  const endH = await resolveNumber({
    branchId,
    key: "quiet_hours_end_h",
    fallback: await getNumberFlag(FLAG_KEYS.BROADCAST_QUIET_HOURS_END_H),
  });
  const hour = bangkokHour(now);
  if (hour >= startH && hour < endH) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `outside Bangkok quiet hours window ${startH}:00–${endH}:00 (current hour: ${hour})`,
  };
}

// ---------- Cross-draft dedup --------------------------------------------

/**
 * Has this customer received ANY broadcast in the last N hours from
 * any prior send_job? Used at fan-out time — when the answer is yes,
 * the target is marked `skipped` with a dedup reason.
 *
 * Implementation: scan broadcast_send_targets for rows older than
 * the current job's `created_at` with status='dispatched' for the
 * same customer within the dedup window. The "newest send wins"
 * rule is enforced naturally: when a NEWER job runs, it sees no
 * recently-dispatched rows (it hasn't dispatched yet). When an
 * OLDER job runs after a newer one started, it skips customers
 * the newer job has already touched.
 */
export async function isRecentlyBroadcasted(opts: {
  customerId: string;
  windowHours: number;
  /** The current job ID — excluded from the lookup so a job doesn't
   *  dedup against itself. */
  currentJobId: string;
}): Promise<boolean> {
  if (opts.windowHours <= 0) return false;
  const admin = getSupabaseAdmin();
  if (!admin) return false;
  const since = new Date(
    Date.now() - opts.windowHours * 60 * 60 * 1000
  ).toISOString();
  const res = await admin
    .from("broadcast_send_targets")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", opts.customerId)
    .eq("status", "dispatched")
    .neq("send_job_id", opts.currentJobId)
    .gte("created_at", since);
  if (res.error) return false;
  return (res.count ?? 0) > 0;
}

// ---------- Scheduling gate ----------------------------------------------

export type ScheduleCheck =
  | { ok: true }
  | { ok: false; reason: string };

/** "Is this job allowed to start now, given its scheduled_for + the
 *  scheduling feature flag?" */
export async function checkSchedule(opts: {
  scheduledFor: string | null;
}): Promise<ScheduleCheck> {
  if (!opts.scheduledFor) return { ok: true };
  const scheduledMs = new Date(opts.scheduledFor).getTime();
  if (Number.isNaN(scheduledMs)) {
    return { ok: false, reason: "invalid scheduled_for timestamp" };
  }
  if (scheduledMs > Date.now()) {
    return {
      ok: false,
      reason: `scheduled for ${opts.scheduledFor} — not yet`,
    };
  }
  // When the job was scheduled, also verify the scheduling feature
  // is still enabled. Flipping it off mid-flight should freeze
  // future scheduled jobs (existing in-flight ones continue).
  const enabled = await getBoolFlag(FLAG_KEYS.ENABLE_SCHEDULED_BROADCASTS);
  if (!enabled) {
    return {
      ok: false,
      reason: "scheduled broadcasts feature flag is off",
    };
  }
  return { ok: true };
}

// ---------- Cross-branch check -------------------------------------------

export type CrossBranchCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify that a send_job's audience doesn't span branches when the
 * cross-branch flag is off. Called at SEND-CREATION time, not on
 * every fan-out tick — re-checking on every tick is wasteful.
 *
 * The check looks at the segment's branchSlugs: if it's null/empty
 * (= "all branches the operator can see") AND the operator is
 * owner/hq_admin AND the flag is off, we refuse. branch_manager is
 * always single-branch by their RLS so this check is a no-op for
 * them.
 */
export async function checkCrossBranch(opts: {
  segmentBranchSlugs: string[];
  operatorRole: string;
}): Promise<CrossBranchCheck> {
  if (opts.operatorRole === "branch_manager") {
    return { ok: true };
  }
  const enabled = await getBoolFlag(FLAG_KEYS.ENABLE_CROSS_BRANCH_BROADCASTS);
  if (enabled) return { ok: true };
  // When the flag is off, the segment must restrict to exactly ONE
  // branch.
  const slugs = (opts.segmentBranchSlugs ?? []).filter(Boolean);
  if (slugs.length === 1) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      slugs.length === 0
        ? "cross-branch broadcasts disabled — segment must specify exactly one branch"
        : `cross-branch broadcasts disabled — segment spans ${slugs.length} branches`,
  };
}

// ---------- Channel master gate ------------------------------------------

export async function isChannelEnabled(channel: string): Promise<boolean> {
  if (channel === "sms") return getBoolFlag(FLAG_KEYS.ENABLE_SMS);
  if (channel === "line") return getBoolFlag(FLAG_KEYS.ENABLE_LINE_BROADCAST);
  // Email is not in the flags catalog yet — return false until it is.
  if (channel === "email") return false;
  return false;
}

// ---------- Pre-flight active-job overlap (Phase 21) --------------------

/**
 * Phase 21: at SEND-CREATE time, refuse if more than a threshold of
 * the proposed audience is already targeted by another live send_job
 * (queued / processing / paused). Stops "operator clicks Send twice
 * before the first fan-out finishes" or "two campaigns running over
 * the same VIP cohort at once".
 *
 * Implementation: read distinct customer_ids from
 * broadcast_send_targets for live jobs other than the current one
 * (id is null at send-create because the row doesn't exist yet).
 * The default threshold is 50% — if more than half the audience is
 * already touched, refuse.
 */
export async function checkActiveJobOverlap(opts: {
  customerIds: string[];
  excludeJobId?: string | null;
  /** 0..1; default 0.5 = refuse when >= 50% overlap. */
  thresholdRatio?: number;
}): Promise<
  | { ok: true; overlapCount: number; overlapRatio: number }
  | { ok: false; reason: string; overlapCount: number; overlapRatio: number }
> {
  const admin = getSupabaseAdmin();
  if (!admin || opts.customerIds.length === 0) {
    return { ok: true, overlapCount: 0, overlapRatio: 0 };
  }
  const threshold = Math.max(0, Math.min(1, opts.thresholdRatio ?? 0.5));

  // Match the worker's dedup window — same horizon for consistency.
  const windowHours = await getNumberFlag(FLAG_KEYS.BROADCAST_DEDUP_WINDOW_HOURS);
  const since = new Date(
    Date.now() - Math.max(1, windowHours) * 60 * 60 * 1000
  ).toISOString();

  // Pull customer_ids in chunks (Supabase URL/query-param size limits).
  const CHUNK = 200;
  const overlapSet = new Set<string>();
  for (let i = 0; i < opts.customerIds.length; i += CHUNK) {
    const slice = opts.customerIds.slice(i, i + CHUNK);
    let q = admin
      .from("broadcast_send_targets")
      .select("customer_id, send_job_id, broadcast_send_jobs!inner(status)")
      .in("customer_id", slice)
      .in("status", ["pending", "dispatched"])
      .gte("created_at", since);
    if (opts.excludeJobId) {
      q = q.neq("send_job_id", opts.excludeJobId);
    }
    const res = await q;
    if (res.error) continue;
    const rows = (res.data ?? []) as unknown as Array<{
      customer_id: string;
      broadcast_send_jobs:
        | { status: string }
        | Array<{ status: string }>
        | null;
    }>;
    for (const r of rows) {
      // Supabase types the embedded relation as either object or array
      // depending on whether the FK is one-or-many; we accept both.
      const jobs = r.broadcast_send_jobs;
      const status = Array.isArray(jobs) ? jobs[0]?.status : jobs?.status;
      // Live jobs only — completed / failed / cancelled don't matter.
      if (status && ["queued", "processing", "paused"].includes(status)) {
        overlapSet.add(r.customer_id);
      }
    }
  }
  const overlapCount = overlapSet.size;
  const overlapRatio = opts.customerIds.length
    ? overlapCount / opts.customerIds.length
    : 0;
  if (overlapRatio >= threshold) {
    return {
      ok: false,
      reason: `cross-draft overlap: ${overlapCount}/${opts.customerIds.length} (${Math.round(overlapRatio * 100)}%) ลูกค้าอยู่ใน send_job ที่ยัง active — pause/cancel งานเดิมก่อน`,
      overlapCount,
      overlapRatio,
    };
  }
  return { ok: true, overlapCount, overlapRatio };
}

// ---------- Cap check ----------------------------------------------------

/**
 * "Does this audience fit under broadcast_max_targets_per_job?"
 * Called at send-creation time. Refusing too-large jobs at creation
 * time is friendlier than dead-lettering them mid-flight.
 */
export async function checkAudienceCap(opts: {
  expectedTargets: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cap = await getNumberFlag(FLAG_KEYS.BROADCAST_MAX_TARGETS_PER_JOB);
  if (opts.expectedTargets <= cap) return { ok: true };
  return {
    ok: false,
    reason: `audience ${opts.expectedTargets} exceeds per-job cap ${cap} — refine the segment`,
  };
}
