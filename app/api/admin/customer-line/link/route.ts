// POST /api/admin/customer-line/link — pair a captured LINE follower with
// a real customer row.
//
// Auth model:
//   • requireRole(owner / hq_admin) — branch_manager is intentionally
//     excluded because customer_line_links spans branches (a customer's
//     LINE follow doesn't carry a branch on its own; the customer they
//     belong to does, but cross-branch linking is an HQ concern).
//   • Re-check that the target customer exists.
//   • Idempotency: if the link row already has the same customer_id, no
//     write happens and we return ok=true with alreadyLinked=true.
//
// Integrity rules enforced server-side:
//   • One LINE user (line_user_id) → at most ONE active link. The DB
//     unique index `customer_line_links_line_user_id_uniq` already
//     guarantees this at write time; we never need to delete an existing
//     row, only update its customer_id.
//   • One customer can have multiple LINE links (rare but allowed —
//     family-shared lines). We DO NOT block this server-side; instead the
//     UI surfaces existing links for the same customer so the admin can
//     decide.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  linkId?: string;
  customerId?: string;
};

export async function POST(req: Request) {
  const guarded = await requireRole(["owner", "hq_admin"]);
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

  const linkId = body.linkId?.trim();
  const customerId = body.customerId?.trim();
  if (!linkId || !customerId) {
    return NextResponse.json(
      { ok: false, reason: "Missing linkId or customerId" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      {
        ok: false,
        reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า",
      },
      { status: 503 }
    );
  }

  // Confirm the link row exists. Pull current customer_id to detect a
  // no-op rebind.
  const linkRes = await admin
    .from("customer_line_links")
    .select("id, customer_id, line_user_id, ignored_at")
    .eq("id", linkId)
    .maybeSingle();
  if (linkRes.error || !linkRes.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบรายการ customer_line_links ที่ระบุ" },
      { status: 404 }
    );
  }
  const link = linkRes.data as {
    id: string;
    customer_id: string | null;
    line_user_id: string;
    ignored_at: string | null;
  };
  if (link.customer_id === customerId) {
    return NextResponse.json({ ok: true, alreadyLinked: true });
  }

  // Confirm the customer exists.
  const custRes = await admin
    .from("customers")
    .select("id, name, branch_id")
    .eq("id", customerId)
    .maybeSingle();
  if (custRes.error || !custRes.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบลูกค้าที่ระบุ" },
      { status: 404 }
    );
  }

  const now = new Date().toISOString();
  const { error } = await admin
    .from("customer_line_links")
    .update({
      customer_id: customerId,
      ignored_at: null, // Linking always un-ignores.
      ignored_by: null,
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
  return NextResponse.json({
    ok: true,
    linkId,
    customerId,
    linkedBy: profile.id,
  });
}
