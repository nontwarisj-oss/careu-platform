// POST /api/admin/onboarding/activate-branch — flip is_active on / off.
//
// Separate from create-branch so HQ can:
//   • Activate a branch after the LINE config + brandConfig mirror are
//     populated.
//   • Deactivate a branch (close franchise, paused operations) without
//     deleting any rows. Existing orders + customers continue to exist
//     and stay in their branch; the branch just disappears from
//     selectors.
//
// Owner / hq_admin only.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  branchId?: string;
  isActive?: boolean;
};

export async function POST(req: Request) {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  if (!body.branchId || typeof body.isActive !== "boolean") {
    return NextResponse.json(
      { ok: false, reason: "Missing branchId or isActive" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  const res = await admin
    .from("branches")
    .update({ is_active: body.isActive })
    .eq("id", body.branchId)
    .select("id, code, is_active")
    .single();
  if (res.error || !res.data) {
    return NextResponse.json(
      { ok: false, reason: res.error?.message ?? "Update failed" },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, branch: res.data });
}
