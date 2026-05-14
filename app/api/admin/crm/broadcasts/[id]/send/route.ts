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
  checkAudienceCap,
  checkCrossBranch,
  checkSchedule,
  isChannelEnabled,
} from "@/lib/broadcastPolicyService";
import { getBoolFlag, FLAG_KEYS } from "@/lib/featureFlags";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  mode?: "live" | "dry_run";
  scheduledFor?: string | null;
};

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
  if (draft.branch_id) {
    const guard = await requireBranchAccess(draft.branch_id);
    if (guard instanceof NextResponse) return guard;
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
