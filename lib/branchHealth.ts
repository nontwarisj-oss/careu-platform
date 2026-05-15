// Branch Health — per-branch operational health rollup.
//
// computeWorkerHealth() (lib/workerHealth.ts) answers "is the
// PLATFORM healthy?" — crons + the global queue. Branch managers
// need the branch-scoped question: "is MY branch healthy?" — failed
// sends, dead letters, stuck broadcast jobs, unresolved alerts,
// paused campaigns.
//
// Each branch is one cheap round of count() queries. At franchise
// scale (≤ ~15 branches) this is well within an on-demand admin
// dashboard's budget.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { branches as ALL_BRANCHES } from "@/lib/brandConfig";

export type BranchHealth = {
  branchId: string;
  branchLabel: string;
  /** customer_notifications status='failed' in the last 24h. */
  failedSends24h: number;
  /** customer_notifications status='dead_letter' (all-time open). */
  deadLetters: number;
  /** broadcast_send_jobs stuck 'processing' > 6h. */
  stuckBroadcastJobs: number;
  /** alert_events still active / acknowledged for this branch. */
  unresolvedAlerts: number;
  /** alert_events unresolved AND severity='critical'. */
  criticalAlerts: number;
  /** broadcast_drafts in status 'paused'. */
  pausedCampaigns: number;
  status: "healthy" | "warning" | "critical";
};

function branchLabel(code: string): string {
  const hit = ALL_BRANCHES.find(
    (b) => b.id === code || b.branchCode === code
  );
  return hit?.shortLabel ?? code;
}

async function healthForBranch(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  branchId: string
): Promise<BranchHealth> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const stuckCutoff = new Date(
    Date.now() - 6 * 60 * 60 * 1000
  ).toISOString();

  const safeCount = async (q: PromiseLike<{ count: number | null }>) => {
    try {
      const r = await q;
      return r.count ?? 0;
    } catch {
      return 0;
    }
  };

  const failedSends24h = await safeCount(
    admin
      .from("customer_notifications")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed")
      .eq("branch_id", branchId)
      .gte("created_at", since24h)
  );
  const deadLetters = await safeCount(
    admin
      .from("customer_notifications")
      .select("id", { count: "exact", head: true })
      .eq("status", "dead_letter")
      .eq("branch_id", branchId)
  );
  const stuckBroadcastJobs = await safeCount(
    admin
      .from("broadcast_send_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "processing")
      .eq("branch_id", branchId)
      .lt("started_at", stuckCutoff)
  );
  const pausedCampaigns = await safeCount(
    admin
      .from("broadcast_drafts")
      .select("id", { count: "exact", head: true })
      .eq("status", "paused")
      .eq("branch_id", branchId)
  );

  // Unresolved alerts — pull severity so we can split out criticals.
  let unresolvedAlerts = 0;
  let criticalAlerts = 0;
  try {
    const r = await admin
      .from("alert_events")
      .select("severity")
      .eq("branch_id", branchId)
      .in("status", ["active", "acknowledged"]);
    const rows = (r.data ?? []) as Array<{ severity: string }>;
    unresolvedAlerts = rows.length;
    criticalAlerts = rows.filter((x) => x.severity === "critical").length;
  } catch {
    // best-effort
  }

  let status: BranchHealth["status"] = "healthy";
  if (deadLetters > 0 || stuckBroadcastJobs > 0 || criticalAlerts > 0) {
    status = "critical";
  } else if (failedSends24h > 0 || unresolvedAlerts > 0) {
    status = "warning";
  }

  return {
    branchId,
    branchLabel: branchLabel(branchId),
    failedSends24h,
    deadLetters,
    stuckBroadcastJobs,
    unresolvedAlerts,
    criticalAlerts,
    pausedCampaigns,
    status,
  };
}

/**
 * Per-branch operational health. Pass a `branchId` to scope to one
 * branch (branch_manager view); omit it for every branch (HQ view).
 */
export async function computeBranchHealth(opts?: {
  branchId?: string | null;
}): Promise<BranchHealth[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  const branchIds = opts?.branchId
    ? [opts.branchId]
    : ALL_BRANCHES.map((b) => b.id);

  const out: BranchHealth[] = [];
  for (const id of branchIds) {
    out.push(await healthForBranch(admin, id));
  }
  // Worst-health branch first.
  const rank = { critical: 0, warning: 1, healthy: 2 };
  out.sort((a, b) => rank[a.status] - rank[b.status]);
  return out;
}
