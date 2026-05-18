// POST /api/admin/intake-drafts/update — Owner/Admin updates one draft.
//
// Drives the review workflow: change status, save a review note, or record
// the order a draft was converted into. Service-role write (the tables run
// RLS-on / no-policy). Best-effort admin gate, same as the list route.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { isDraftStatus } from "@/lib/intakeDrafts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REVIEW_ROLES = ["owner", "hq_admin", "branch_manager"];

type Body = {
  draftId?: string;
  status?: string;
  adminReviewNote?: string;
  convertedOrderId?: string | null;
};

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (user && !REVIEW_ROLES.includes(user.role)) {
    return NextResponse.json(
      { ok: false, error: "ไม่มีสิทธิ์แก้ไขคิวงาน" },
      { status: 403 }
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 }
    );
  }

  const draftId = (body.draftId ?? "").trim();
  if (!draftId) {
    return NextResponse.json(
      { ok: false, error: "draftId required" },
      { status: 400 }
    );
  }

  const patch: Record<string, unknown> = {};
  if (body.status !== undefined) {
    if (!isDraftStatus(body.status)) {
      return NextResponse.json(
        { ok: false, error: `สถานะ "${body.status}" ไม่ถูกต้อง` },
        { status: 400 }
      );
    }
    patch.status = body.status;
  }
  if (body.adminReviewNote !== undefined) {
    const note = (body.adminReviewNote ?? "").trim();
    patch.admin_review_note = note === "" ? null : note;
  }
  if (body.convertedOrderId !== undefined) {
    const oid = (body.convertedOrderId ?? "").trim();
    patch.converted_order_id = oid === "" ? null : oid;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { ok: false, error: "ไม่มีข้อมูลที่จะอัปเดต" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "service role ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  const res = await admin
    .from("intake_drafts")
    .update(patch)
    .eq("id", draftId)
    .select("id")
    .maybeSingle();
  if (res.error) {
    console.error("[admin/intake-drafts/update] failed", res.error);
    return NextResponse.json(
      { ok: false, error: res.error.message },
      { status: 500 }
    );
  }
  if (!res.data) {
    return NextResponse.json(
      { ok: false, error: "ไม่พบ draft นี้" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}
