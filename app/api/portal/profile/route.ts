// GET / PATCH /api/portal/profile — customer's own profile.
//
// GET returns name + email + branch label + tier + lifecycle stage +
// lifetime spend + total orders. PATCH lets the customer update name +
// email only (phone change goes through a separate OTP-on-new-number
// flow in a future phase — too sensitive to allow without re-verification).

import { NextResponse } from "next/server";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROFILE_COLUMNS =
  "id, name, phone, email, address, customer_tier, lifecycle_stage, branch_id, last_visit_at, total_orders, lifetime_spend";

export async function GET() {
  const session = await readCustomerSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, reason: "ยังไม่ได้เข้าสู่ระบบ" },
      { status: 401 }
    );
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  const res = await admin
    .from("customers")
    .select(PROFILE_COLUMNS)
    .eq("id", session.customerId)
    .maybeSingle();
  if (res.error || !res.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบโปรไฟล์" },
      { status: 404 }
    );
  }
  const row = res.data as Record<string, unknown>;
  return NextResponse.json({
    ok: true,
    profile: {
      id: row.id,
      name: row.name ?? "",
      phone: row.phone ?? "",
      email: row.email === "N/A" ? "" : (row.email as string) ?? "",
      address: row.address === "N/A" ? "" : (row.address as string) ?? "",
      tier: row.customer_tier ?? null,
      lifecycle: row.lifecycle_stage ?? null,
      branchId: row.branch_id ?? null,
      lastVisitAt: row.last_visit_at ?? null,
      totalOrders: Number(row.total_orders ?? 0),
      lifetimeSpend: Number(row.lifetime_spend ?? 0),
    },
  });
}

type PatchBody = {
  name?: string;
  email?: string;
};

export async function PATCH(req: Request) {
  const session = await readCustomerSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, reason: "ยังไม่ได้เข้าสู่ระบบ" },
      { status: 401 }
    );
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const name = (body.name ?? "").trim().slice(0, 200);
  const email = (body.email ?? "").trim().slice(0, 200);
  const patch: Record<string, unknown> = {};
  if (name) patch.name = name;
  if (email) patch.email = email;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { ok: false, reason: "ไม่มีฟิลด์ให้บันทึก" },
      { status: 400 }
    );
  }
  const res = await admin
    .from("customers")
    .update(patch)
    .eq("id", session.customerId);
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
