// GET /api/admin/crm/broadcasts/[id]/jobs — list send_jobs for a draft.
// Used by the broadcast detail page to render the "previous sends"
// section.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const guarded = await requireRole(["owner", "hq_admin", "branch_manager"]);
  if (guarded instanceof NextResponse) return guarded;

  const { id: draftId } = await context.params;
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  // Branch scope: load draft once + check.
  const draftRes = await admin
    .from("broadcast_drafts")
    .select("id, branch_id")
    .eq("id", draftId)
    .maybeSingle();
  if (draftRes.error || !draftRes.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบ draft" },
      { status: 404 }
    );
  }
  const branchId = (draftRes.data as { branch_id: string | null }).branch_id;
  if (branchId) {
    const branchGuard = await requireBranchAccess(branchId);
    if (branchGuard instanceof NextResponse) return branchGuard;
  }

  const res = await admin
    .from("broadcast_send_jobs")
    .select(
      "id, status, mode, scheduled_for, started_at, completed_at, paused_at, cancelled_at, expected_total, channels, created_at, failure_reason"
    )
    .eq("draft_id", draftId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, jobs: res.data ?? [] });
}
