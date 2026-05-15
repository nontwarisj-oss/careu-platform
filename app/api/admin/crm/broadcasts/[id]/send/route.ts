// POST /api/admin/crm/broadcasts/[id]/send — create a send_job for
// the given draft. Three modes:
//   • mode='live'    (default) — real fan-out + dispatch
//   • mode='dry_run' — fan-out + skip enqueue
// Optional scheduledFor — defer the first tick until that timestamp.
//
// Hard-gates before insert:
//   1. Draft exists + caller has branch access.
//   2. Channels valid (sms / line).
//   3. Audience cap not exceeded (broadcast_max_targets_per_job).
//   4. Cross-branch flag if audience spans branches.
//   5. Channel master flags (enable_sms / enable_line_broadcast).
//
// Each refused condition returns a 4xx with a specific reason so the
// UI can render a useful message.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import {
  estimateAudience,
  type SegmentDefinition,
} from "@/lib/crmSegmentationService";
import {
  checkActiveJobOverlap,
  checkAudienceCap,
  checkCrossBranch,
  checkSchedule,
  isChannelEnabled,
} from "@/lib/broadcastPolicyService";
import { getBoolFlag, FLAG_KEYS } from "@/lib/featureFlags";
import { fetchCustomerIdsForSegment } from "@/lib/broadcastSegmentCustomers";
import {
  checkDryRunRequirement,
  checkGlobalDailySendCap,
  checkWeeklyCampaignCap,
  isEmergencyStopped,
} from "@/lib/engagementGuardrails";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  mode?: "live" | "dry_run";
  scheduledFor?: string | null;
  /** Owner-only: bypass the weekly campaign cap. Every override is
   *  audited. branch_manager / hq_admin cannot set this. */
  overrideWeeklyCap?: boolean;
};

/** Write a broadcast_audit_log row for a blocked / overridden send so
 *  every cap decision is traceable. Best-effort. */
async function auditGuardrail(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  draftId: string,
  actorId: string,
  ip: string,
  outcome: "blocked" | "override",
  detail: Record<string, unknown>
): Promise<void> {
  try {
    await admin.from("broadcast_audit_log").insert({
      draft_id: draftId,
      action: "update",
      actor_id: actorId,
      after_value: { guardrail: outcome, ...detail },
      request_ip: ip === "unknown" ? null : ip,
    });
  } catch {
    // best-effort
  }
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "broadcast-send",
    limit: 10,
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
  const actorId = profile.id;
  const role = profile.role ?? "owner";

  const { id: draftId } = await context.params;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }
  const mode = body.mode === "dry_run" ? "dry_run" : "live";
  const scheduledFor = body.scheduledFor ?? null;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  // 1. Load draft + branch check.
  const draftRes = await admin
    .from("broadcast_drafts")
    .select(
      "id, name, segment, template_sms, template_line, channels, status, branch_id"
    )
    .eq("id", draftId)
    .maybeSingle();
  if (draftRes.error || !draftRes.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบ draft" },
      { status: 404 }
    );
  }
  const draft = draftRes.data as {
    id: string;
    name: string;
    segment: SegmentDefinition;
    template_sms: string | null;
    template_line: string | null;
    channels: string[];
    status: string;
    branch_id: string | null;
  };
  if (draft.status === "archived") {
    return NextResponse.json(
      { ok: false, reason: "draft ถูก archive แล้ว" },
      { status: 409 }
    );
  }
  if (draft.status === "paused") {
    // Phase 21: per-draft pause blocks send.
    return NextResponse.json(
      { ok: false, reason: "draft ถูก pause แล้ว — resume ก่อนส่ง" },
      { status: 409 }
    );
  }
  if (draft.branch_id) {
    const guard = await requireBranchAccess(draft.branch_id);
    if (guard instanceof NextResponse) return guard;
  }

  // 1b. Phase 22: engagement guardrails. Caps are enforced at
  //     send-CREATE so an over-budget campaign is refused with a
  //     clear reason instead of dead-lettering mid-flight. Dry-run
  //     sends are exempt from the daily/weekly caps + dry-run
  //     requirement (a dry-run IS how you satisfy the requirement)
  //     but NOT from the emergency stop.
  if (await isEmergencyStopped()) {
    await auditGuardrail(admin, draft.id, actorId, ip, "blocked", {
      bucket: "global_emergency_stop",
      mode,
    });
    return NextResponse.json(
      {
        ok: false,
        reason:
          "global emergency stop is ON — all sends halted. Clear it in /admin/system/guardrails.",
        bucket: "global_emergency_stop",
      },
      { status: 409 }
    );
  }

  if (mode === "live") {
    // Global + per-branch daily send cap.
    const dailyCap = await checkGlobalDailySendCap(draft.branch_id);
    if (!dailyCap.ok) {
      await auditGuardrail(admin, draft.id, actorId, ip, "blocked", {
        bucket: dailyCap.bucket,
        reason: dailyCap.reason,
      });
      return NextResponse.json(
        { ok: false, reason: dailyCap.reason, bucket: dailyCap.bucket },
        { status: 409 }
      );
    }

    // Weekly campaigns-per-branch cap. Owner may override; every
    // override is audited.
    const weeklyCap = await checkWeeklyCampaignCap(draft.branch_id);
    if (!weeklyCap.ok) {
      const wantsOverride = body.overrideWeeklyCap === true;
      if (wantsOverride && role === "owner") {
        await auditGuardrail(admin, draft.id, actorId, ip, "override", {
          bucket: weeklyCap.bucket,
          reason: weeklyCap.reason,
          overriddenBy: actorId,
        });
        // fall through — owner override accepted + audited.
      } else {
        await auditGuardrail(admin, draft.id, actorId, ip, "blocked", {
          bucket: weeklyCap.bucket,
          reason: weeklyCap.reason,
          overrideAttempted: wantsOverride,
        });
        return NextResponse.json(
          {
            ok: false,
            reason: wantsOverride
              ? `${weeklyCap.reason} — เฉพาะ owner เท่านั้นที่ override ได้`
              : weeklyCap.reason,
            bucket: weeklyCap.bucket,
            overridable: true,
          },
          { status: 409 }
        );
      }
    }

    // Dry-run requirement — needs a fresh dry-run matching the
    // current draft version (see checkDryRunRequirement).
    const dryRunReq = await checkDryRunRequirement({
      draftId: draft.id,
      branchId: draft.branch_id,
    });
    if (!dryRunReq.ok) {
      await auditGuardrail(admin, draft.id, actorId, ip, "blocked", {
        bucket: dryRunReq.bucket,
        reason: dryRunReq.reason,
      });
      return NextResponse.json(
        { ok: false, reason: dryRunReq.reason, bucket: dryRunReq.bucket },
        { status: 409 }
      );
    }
  }

  // 2. Channels valid?
  const channels = (draft.channels ?? []).filter(
    (c) => c === "sms" || c === "line"
  );
  if (channels.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        reason: "ต้องมีอย่างน้อย 1 ช่องทาง (sms / line) และมีเทมเพลตเขียนไว้",
      },
      { status: 400 }
    );
  }
  for (const ch of channels) {
    if (ch === "sms" && !draft.template_sms?.trim()) {
      return NextResponse.json(
        { ok: false, reason: "เปิด SMS แต่ template ว่าง" },
        { status: 400 }
      );
    }
    if (ch === "line" && !draft.template_line?.trim()) {
      return NextResponse.json(
        { ok: false, reason: "เปิด LINE แต่ template ว่าง" },
        { status: 400 }
      );
    }
    const enabled = await isChannelEnabled(ch);
    if (!enabled) {
      return NextResponse.json(
        {
          ok: false,
          reason: `feature flag ปิด ${ch} broadcasts — ตั้งค่า enable_${ch === "sms" ? "sms" : "line_broadcast"}`,
        },
        { status: 409 }
      );
    }
  }

  // 3. Cross-branch flag.
  const crossBranch = await checkCrossBranch({
    segmentBranchSlugs: draft.segment?.branchSlugs ?? [],
    operatorRole: role,
  });
  if (!crossBranch.ok) {
    return NextResponse.json(
      { ok: false, reason: crossBranch.reason },
      { status: 409 }
    );
  }

  // 4. Audience size + cap.
  const counts = await estimateAudience({
    segment: draft.segment,
    scope: {
      scopedBranchCodes:
        role === "owner" || role === "hq_admin"
          ? null
          : profile.branchCode
            ? [profile.branchCode]
            : [],
    },
  });
  const expectedTargets = counts.totalMatch * channels.length;
  const capCheck = await checkAudienceCap({ expectedTargets });
  if (!capCheck.ok) {
    return NextResponse.json(
      { ok: false, reason: capCheck.reason },
      { status: 409 }
    );
  }

  // 4b. Phase 21: cross-draft overlap pre-flight. Refuses sends that
  //     would re-target customers currently sitting in another active
  //     send_job. The worker also dedups at fan-out time; this gate
  //     gives the operator an early, descriptive error before they
  //     spend audit + DB churn on a no-op job.
  const customerIds = await fetchCustomerIdsForSegment({
    segment: draft.segment,
    branchId: draft.branch_id,
  });
  const overlap = await checkActiveJobOverlap({
    customerIds,
    excludeJobId: null,
    thresholdRatio: 0.5,
  });
  if (!overlap.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason: overlap.reason,
        overlapCount: overlap.overlapCount,
        overlapRatio: overlap.overlapRatio,
      },
      { status: 409 }
    );
  }

  // 5. Schedule check (refuses scheduled sends when scheduling flag
  // is off; ok=true when scheduledFor is null).
  if (scheduledFor) {
    const enabled = await getBoolFlag(FLAG_KEYS.ENABLE_SCHEDULED_BROADCASTS);
    if (!enabled) {
      return NextResponse.json(
        { ok: false, reason: "scheduled broadcasts feature flag ปิดอยู่" },
        { status: 409 }
      );
    }
    const sched = await checkSchedule({ scheduledFor });
    if (!sched.ok && !/not yet/.test(sched.reason)) {
      // "not yet" is FINE here — we WANT to schedule for the future.
      return NextResponse.json(
        { ok: false, reason: sched.reason },
        { status: 400 }
      );
    }
  }

  // 6. Insert the send_job. The fan-out cron picks it up on the next
  // tick (or immediately when scheduledFor is null).
  const ins = await admin
    .from("broadcast_send_jobs")
    .insert({
      draft_id: draft.id,
      segment_snapshot: draft.segment ?? {},
      template_sms_snapshot: draft.template_sms,
      template_line_snapshot: draft.template_line,
      channels,
      branch_id: draft.branch_id,
      scheduled_for: scheduledFor,
      mode,
      status: "queued",
      created_by: actorId,
    })
    .select("id")
    .single();
  if (ins.error || !ins.data) {
    return NextResponse.json(
      { ok: false, reason: ins.error?.message ?? "Insert failed" },
      { status: 500 }
    );
  }
  const jobId = (ins.data as { id: string }).id;

  await admin.from("broadcast_audit_log").insert({
    draft_id: draft.id,
    action: "send_queued",
    actor_id: actorId,
    after_value: {
      send_job_id: jobId,
      mode,
      scheduled_for: scheduledFor,
      channels,
      expected_targets: expectedTargets,
    },
    request_ip: ip === "unknown" ? null : ip,
  });

  return NextResponse.json({
    ok: true,
    sendJobId: jobId,
    mode,
    scheduledFor,
    expectedTargets,
    estimatedReach: {
      sms: counts.reachableSms,
      line: counts.reachableLine,
    },
  });
}
