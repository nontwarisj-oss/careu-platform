// Lightweight, IDs-only customer lookup for a broadcast segment.
//
// Extracted from lib/broadcastSendWorker.ts so the send-create API
// can run a pre-flight cross-draft-overlap check before inserting
// a send_job. The worker still uses this same function on its first
// fan-out tick — keeping the logic in one place protects against
// drift between "what the operator was warned about" and "what
// actually gets enqueued".
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type { SegmentDefinition } from "@/lib/crmSegmentationService";

export async function fetchCustomerIdsForSegment(opts: {
  segment: SegmentDefinition;
  branchId: string | null;
}): Promise<string[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const { segment, branchId } = opts;

  // Bumping the cap here is safe; the audience-cap flag is the real
  // ceiling. 5000 matches the worker's per-tick fan-out budget.
  let q = admin.from("customers").select("id").limit(5000);

  if (branchId) {
    q = q.eq("branch_id", branchId);
  } else if (segment.branchSlugs && segment.branchSlugs.length > 0) {
    q = q.in("branch_id", segment.branchSlugs);
  }
  if (segment.tiers && segment.tiers.length > 0)
    q = q.in("customer_tier", segment.tiers);
  if (segment.lifecycleStages && segment.lifecycleStages.length > 0)
    q = q.in("lifecycle_stage", segment.lifecycleStages);
  if (segment.customerTypes && segment.customerTypes.length > 0)
    q = q.in("customer_type", segment.customerTypes);
  if (typeof segment.retentionScoreGte === "number")
    q = q.gte("retention_score", segment.retentionScoreGte);
  if (typeof segment.totalSpendGte === "number")
    q = q.gte("lifetime_spend", segment.totalSpendGte);
  if (typeof segment.totalOrdersGte === "number")
    q = q.gte("total_orders", segment.totalOrdersGte);
  if (
    typeof segment.inactiveDaysGte === "number" &&
    segment.inactiveDaysGte > 0
  ) {
    const cutoff = new Date(
      Date.now() - segment.inactiveDaysGte * 24 * 60 * 60 * 1000
    ).toISOString();
    q = q.lte("last_visit_at", cutoff);
  }
  if (
    typeof segment.activeWithinDays === "number" &&
    segment.activeWithinDays > 0
  ) {
    const cutoff = new Date(
      Date.now() - segment.activeWithinDays * 24 * 60 * 60 * 1000
    ).toISOString();
    q = q.gte("last_visit_at", cutoff);
  }
  if (segment.requirePhone) q = q.not("normalized_phone", "is", null);

  const res = await q;
  if (res.error || !res.data) return [];
  return ((res.data as Array<{ id: string }>) ?? []).map((r) => r.id);
}
