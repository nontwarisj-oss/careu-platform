// POST /api/admin/crm/audiences/estimate — compute audience counts for
// an arbitrary segment + cache the snapshot when a draft id is given.
//
// Two call modes:
//
//   1. Standalone (no draftId): the audience builder UI lets operators
//      iterate on a segment definition without saving a draft yet.
//      Returns counts only; nothing persists.
//
//   2. Linked to a draft (draftId in body): same compute, but ALSO
//      writes a row to broadcast_audience_snapshots so the draft's
//      preview UI doesn't recompute on every refresh.
//
// Rate-limited 20/10min/IP — estimation is moderately expensive.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import {
  estimateAudience,
  estimateCostThb,
  type SegmentDefinition,
} from "@/lib/crmSegmentationService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  segment?: SegmentDefinition;
  draftId?: string | null;
};

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "audience-estimate",
    limit: 20,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "ลองมากเกินไป" },
      { status: 429 }
    );
  }

  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
  ]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;
  const role = profile.role ?? "owner";
  const branchCode = profile.branchCode ?? null;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const segment = body.segment ?? {};
  const draftId = body.draftId ?? null;

  // Branch scope for the segmentation service.
  const scopedBranchCodes =
    role === "owner" || role === "hq_admin"
      ? null
      : branchCode
        ? [branchCode]
        : [];

  // If the request is linked to a draft, the draft's branch must be
  // accessible to the caller. Loads the draft once and uses its
  // branch_id for the access check.
  let draftRow: { id: string; branch_id: string | null } | null = null;
  if (draftId) {
    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
        { status: 503 }
      );
    }
    const dr = await admin
      .from("broadcast_drafts")
      .select("id, branch_id")
      .eq("id", draftId)
      .maybeSingle();
    if (dr.error || !dr.data) {
      return NextResponse.json(
        { ok: false, reason: "ไม่พบ draft" },
        { status: 404 }
      );
    }
    draftRow = dr.data as { id: string; branch_id: string | null };
    if (draftRow.branch_id) {
      const guard = await requireBranchAccess(draftRow.branch_id);
      if (guard instanceof NextResponse) return guard;
    }
  }

  const counts = await estimateAudience({
    segment,
    scope: { scopedBranchCodes },
  });
  const cost = estimateCostThb(counts);

  // Persist the snapshot when linked to a draft.
  if (draftRow) {
    const admin = getSupabaseAdmin()!;
    await admin.from("broadcast_audience_snapshots").insert({
      draft_id: draftRow.id,
      total_match: counts.totalMatch,
      reachable_line: counts.reachableLine,
      reachable_sms: counts.reachableSms,
      reachable_email: counts.reachableEmail,
      opted_out_line: counts.optedOutLine,
      opted_out_sms: counts.optedOutSms,
      opted_out_email: counts.optedOutEmail,
      distribution: counts.distribution,
      estimated_cost_thb: cost,
      computed_by: profile.id,
    });
    // Also flip the draft status to 'preview' on first estimate —
    // signal that the operator has reviewed the audience size.
    await admin
      .from("broadcast_drafts")
      .update({ status: "preview", updated_by: profile.id })
      .eq("id", draftRow.id)
      .eq("status", "draft");
    await admin.from("broadcast_audit_log").insert({
      draft_id: draftRow.id,
      action: "estimate",
      actor_id: profile.id,
      after_value: {
        totalMatch: counts.totalMatch,
        reachableLine: counts.reachableLine,
        reachableSms: counts.reachableSms,
        reachableEmail: counts.reachableEmail,
        estimatedCostThb: cost,
      },
      request_ip: ip === "unknown" ? null : ip,
    });
  }

  return NextResponse.json({
    ok: true,
    counts,
    estimatedCostThb: cost,
    estimatedAt: new Date().toISOString(),
    cached: !!draftRow,
  });
}
