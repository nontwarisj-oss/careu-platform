// POST /api/admin/customer-line/ignore — hide an unlinked follower from
// the unmatched-links view. Use case: a probe / test follow / someone
// who unfollowed quickly. Differs from unsubscribe (which is the
// customer's decision via LINE's UI) in that "ignored" is the admin's
// triage state.
//
// Sending the same linkId again is a no-op acknowledgement. Linking the
// row to a real customer (POST /link) automatically clears ignored_at.
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
    .select("id, ignored_at")
    .eq("id", linkId)
    .maybeSingle();
  if (linkRes.error || !linkRes.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบรายการ customer_line_links" },
      { status: 404 }
    );
  }
  if ((linkRes.data as { ignored_at: string | null }).ignored_at) {
    return NextResponse.json({ ok: true, alreadyIgnored: true });
  }

  const now = new Date().toISOString();
  const { error } = await admin
    .from("customer_line_links")
    .update({
      ignored_at: now,
      ignored_by: profile.id,
      updated_at: now,
      updated_by: profile.id,
    })
    .eq("id", linkId);
  if (error) {
    return NextResponse.json(
      { ok: false, reason: error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, linkId, ignoredAt: now });
}
