// POST /api/admin/crm/broadcasts/[id]/pause — set draft status='paused'.
// See sibling resume/route.ts for the resume flow.
//
// Phase 21. Per-DRAFT pause/resume — distinct from the per-job
// pause that already exists at /jobs/[jobId]. A paused draft:
//   • Cannot be sent (POST /send returns 409).
//   • Pauses every active send_job (status='queued' or 'processing')
//     for the draft via a single update.
//
// Branch scope: branch_manager can pause/resume drafts in their own
// branch; owner/HQ pause/resume anything.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "broadcast-pause",
    limit: 30,
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
  const actorId = guarded.profile.id;

  const { id: draftId } = await context.params;
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  const draftRes = await admin
    .from("broadcast_drafts")
    .select("id, name, branch_id, status")
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
    branch_id: string | null;
    status: string;
  };
  if (draft.branch_id) {
    const guard = await requireBranchAccess(draft.branch_id);
    if (guard instanceof NextResponse) return guard;
  }
  if (draft.status === "archived") {
    return NextResponse.json(
      { ok: false, reason: "draft ถูก archive แล้ว — ไม่สามารถ pause" },
      { status: 409 }
    );
  }
  if (draft.status === "paused") {
    return NextResponse.json({ ok: true, alreadyPaused: true });
  }
  const upd = await admin
    .from("broadcast_drafts")
    .update({ status: "paused", updated_by: actorId })
    .eq("id", draftId);
  if (upd.error) {
    return NextResponse.json(
      { ok: false, reason: upd.error.message },
      { status: 500 }
    );
  }
  // Pause every active send_job for the draft.
  const jobs = await admin
    .from("broadcast_send_jobs")
    .update({
      status: "paused",
      paused_at: new Date().toISOString(),
      paused_by: actorId,
    })
    .eq("draft_id", draftId)
    .in("status", ["queued", "processing"])
    .select("id");
  const pausedJobIds = ((jobs.data ?? []) as Array<{ id: string }>).map(
    (j) => j.id
  );
  await admin.from("broadcast_audit_log").insert({
    draft_id: draftId,
    action: "pause",
    actor_id: actorId,
    before_value: { status: draft.status },
    after_value: { status: "paused", pausedJobs: pausedJobIds },
    request_ip: ip === "unknown" ? null : ip,
  });
  return NextResponse.json({
    ok: true,
    pausedJobs: pausedJobIds,
    pausedJobCount: pausedJobIds.length,
  });
}
