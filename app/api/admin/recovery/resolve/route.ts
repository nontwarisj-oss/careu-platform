// POST /api/admin/recovery/resolve — mark a sync_failures row as resolved.
//
// Auth model:
//   • owner / hq_admin → may resolve any branch's failure.
//   • branch_manager → may resolve only their own branch's failure. The
//     row's branch_id (text slug) is re-checked against the caller's
//     profile.branchCode via requireBranchAccess.
//   • everyone else → 403.
//
// Why a route handler instead of a client-side update: marking resolved
// requires the service-role client because sync_failures has no UPDATE
// policy for authenticated users (every write goes through the server).
// The route is the only path that combines role + branch enforcement.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  failureId?: string;
  note?: string;
};

export async function POST(req: Request) {
  const guarded = await requireRole(["owner", "hq_admin", "branch_manager"]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const failureId = body.failureId;
  if (!failureId) {
    return NextResponse.json(
      { ok: false, reason: "Missing failureId" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      {
        ok: false,
        reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า — resolve ใช้งานไม่ได้",
      },
      { status: 503 }
    );
  }

  // Load the row first so we can branch-check.
  const fetched = await admin
    .from("sync_failures")
    .select("id, branch_id, status, payload")
    .eq("id", failureId)
    .maybeSingle();
  if (fetched.error || !fetched.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบรายการที่ต้องการ" },
      { status: 404 }
    );
  }

  const row = fetched.data as {
    id: string;
    branch_id: string | null;
    status: string;
    payload: Record<string, unknown> | null;
  };

  if (row.branch_id) {
    const branchGuard = await requireBranchAccess(row.branch_id);
    if (branchGuard instanceof NextResponse) return branchGuard;
  }

  // Idempotency — already resolved rows return ok=true without a redundant
  // write so the UI's optimistic state stays consistent.
  if (row.status === "resolved") {
    return NextResponse.json({ ok: true, alreadyResolved: true });
  }

  // Preserve existing payload context; append the resolution note as a
  // sibling key rather than overwriting.
  const nextPayload: Record<string, unknown> = {
    ...(row.payload ?? {}),
    resolvedBy: profile.id,
    resolvedAt: new Date().toISOString(),
  };
  if (body.note && body.note.trim().length > 0) {
    nextPayload.resolutionNote = body.note.trim();
  }

  const { error } = await admin
    .from("sync_failures")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      payload: nextPayload,
    })
    .eq("id", failureId);

  if (error) {
    return NextResponse.json(
      { ok: false, reason: error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
