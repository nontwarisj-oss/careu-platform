// POST /api/admin/customer-line/unlink — break the customer ↔ LINE link
// for a captured follower without unsubscribing them. Clears customer_id;
// the LINE user can be paired with a different customer later.
//
// Use case: admin paired the wrong customer and wants to redo it. The
// follow audit row (line_follow_events) is untouched — only the active
// link is reset to the unmapped state.
//
// Auth: owner / hq_admin only.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;

  let body: { linkId?: string };
  try {
    body = (await req.json()) as { linkId?: string };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const linkId = body.linkId?.trim();
  if (!linkId) {
    return NextResponse.json(
      { ok: false, reason: "Missing linkId" },
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

  const linkRes = await admin
    .from("customer_line_links")
    .select("id, customer_id")
    .eq("id", linkId)
    .maybeSingle();
  if (linkRes.error || !linkRes.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบรายการ customer_line_links ที่ระบุ" },
      { status: 404 }
    );
  }
  if ((linkRes.data as { customer_id: string | null }).customer_id === null) {
    // Already unlinked — idempotent ack.
    return NextResponse.json({ ok: true, alreadyUnlinked: true });
  }

  const { error } = await admin
    .from("customer_line_links")
    .update({
      customer_id: null,
      updated_by: profile.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", linkId);
  if (error) {
    return NextResponse.json(
      { ok: false, reason: error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, linkId });
}
