// GET /api/portal/auth/me — current customer session, used by the portal
// shell to decide whether to render the signed-in view.
//
// Cheap — reads the cookie, decodes it, hydrates a few customer columns.
// Returns { ok: true, customer } when signed in, { ok: false } when not.

import { NextResponse } from "next/server";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const session = await readCustomerSessionFromCookies();
  if (!session) {
    return NextResponse.json({ ok: false, reason: "not signed in" });
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    // Cookie is valid but we can't hydrate. Return what we know.
    return NextResponse.json({
      ok: true,
      customer: {
        id: session.customerId,
        name: session.name ?? null,
        phone: session.phone,
        tier: null,
        lifecycle: null,
        branchId: null,
      },
    });
  }
  const res = await admin
    .from("customers")
    .select(
      "id, name, phone, customer_tier, lifecycle_stage, branch_id, last_visit_at, total_orders, lifetime_spend"
    )
    .eq("id", session.customerId)
    .maybeSingle();
  if (res.error || !res.data) {
    return NextResponse.json({ ok: false, reason: "ลูกค้าไม่อยู่ในระบบแล้ว" });
  }
  const row = res.data as {
    id: string;
    name: string | null;
    phone: string | null;
    customer_tier: string | null;
    lifecycle_stage: string | null;
    branch_id: string | null;
    last_visit_at: string | null;
    total_orders: number | string | null;
    lifetime_spend: number | string | null;
  };
  return NextResponse.json({
    ok: true,
    customer: {
      id: row.id,
      name: row.name,
      phone: row.phone,
      tier: row.customer_tier,
      lifecycle: row.lifecycle_stage,
      branchId: row.branch_id,
      lastVisitAt: row.last_visit_at,
      totalOrders: Number(row.total_orders ?? 0),
      lifetimeSpend: Number(row.lifetime_spend ?? 0),
    },
  });
}
