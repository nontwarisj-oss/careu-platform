// POST /api/admin/crm/broadcasts/[id]/resume — sibling of pause/route.ts.
// See pause/route.ts for the full pause/resume contract — the actual
// logic is shared via the handler there.

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
      { ok: false, reason: "draft ถูก archive แล้ว — restore ก่อน resume" },
      { status: 409 }
    );
  }
  if (draft.status !== "paused") {
    return NextResponse.json(
      { ok: false, reason: `draft อยู่ในสถานะ ${draft.status} (ไม่ใช่ paused)` },
      { status: 409 }
    );
  }
  const upd = await admin
    .from("broadcast_drafts")
    .update({ status: "draft", updated_by: actorId })
    .eq("id", draftId);
  if (upd.error) {
    return NextResponse.json(
      { ok: false, reason: upd.error.message },
      { status: 500 }
    );
  }
  const jobs = await admin
    .from("broadcast_send_jobs")
    .update({
      status: "queued",
      paused_at: null,
      paused_by: null,
    })
    .eq("draft_id", draftId)
    .eq("status", "paused")
    .select("id");
  const resumedJobIds = ((jobs.data ?? []) as Array<{ id: string }>).map(
    (j) => j.id
  );
  await admin.from("broadcast_audit_log").insert({
    draft_id: draftId,
    action: "resume",
    actor_id: actorId,
    before_value: { status: "paused" },
    after_value: { status: "draft", resumedJobs: resumedJobIds },
    request_ip: ip === "unknown" ? null : ip,
  });
  return NextResponse.json({
    ok: true,
    resumedJobs: resumedJobIds,
    resumedJobCount: resumedJobIds.length,
  });
}
