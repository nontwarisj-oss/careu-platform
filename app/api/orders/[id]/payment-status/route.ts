// PATCH /api/orders/[id]/payment-status
//
// Server-side payment-status update for order documents. Internal staff auth
// is localStorage-based (no SESSION_SECRET, no signed cookie), so the acting
// staff member is resolved via resolveStaffActor:
//   • a signed session cookie when one exists, else
//   • the x-careu-staff-id header, validated against staff_accounts (must be a
//     real, active account with a payment-capable role).
// The write itself uses the service-role client (orders RLS bypass).

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveStaffActor } from "@/lib/staffActor";
import { canViewAllBranches } from "@/lib/permissions";
import type { PaymentStatus } from "@/lib/statusBadges";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAYMENT_STATUSES = new Set<PaymentStatus>(["unpaid", "deposit", "paid"]);
const PAYMENT_ROLES = ["owner", "hq_admin", "branch_manager", "front_staff"];

type Body = {
  paymentStatus?: unknown;
};

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const paymentStatus =
    typeof body.paymentStatus === "string" ? body.paymentStatus : "";
  if (!PAYMENT_STATUSES.has(paymentStatus as PaymentStatus)) {
    return NextResponse.json(
      { ok: false, reason: "Invalid payment_status" },
      { status: 400 }
    );
  }

  const { id } = await context.params;
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  // Identify the acting staff member (cookie session, else simple staff auth).
  const actor = await resolveStaffActor(
    admin,
    req.headers.get("x-careu-staff-id")
  );
  if (!actor) {
    return NextResponse.json(
      { ok: false, reason: "ยังไม่ได้เข้าสู่ระบบ" },
      { status: 401 }
    );
  }
  if (!PAYMENT_ROLES.includes(actor.role)) {
    return NextResponse.json(
      { ok: false, reason: `Role "${actor.role}" cannot update payment_status` },
      { status: 403 }
    );
  }

  const orderRes = await admin
    .from("orders")
    .select("id, branch_id, payment_status")
    .eq("id", id)
    .maybeSingle();

  if (orderRes.error) {
    return NextResponse.json(
      { ok: false, reason: orderRes.error.message },
      { status: 500 }
    );
  }
  if (!orderRes.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบใบงาน" },
      { status: 404 }
    );
  }

  const order = orderRes.data as {
    id: string;
    branch_id: string | null;
    payment_status: string | null;
  };

  if (
    order.branch_id &&
    !canViewAllBranches(actor.role) &&
    actor.branchId !== order.branch_id
  ) {
    return NextResponse.json(
      {
        ok: false,
        reason: "Branch access denied",
        requestedBranch: order.branch_id,
        userBranch: actor.branchId,
      },
      { status: 403 }
    );
  }

  const previous = order.payment_status ?? "unpaid";
  const updateRes = await admin
    .from("orders")
    .update({ payment_status: paymentStatus })
    .eq("id", id)
    .select("id, payment_status")
    .maybeSingle();

  if (updateRes.error) {
    return NextResponse.json(
      { ok: false, reason: updateRes.error.message },
      { status: 500 }
    );
  }
  if (!updateRes.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบใบงาน" },
      { status: 404 }
    );
  }

  const auditRes = await admin.from("order_audit_log").insert({
    order_id: id,
    action: "payment_changed",
    before_value: previous,
    after_value: paymentStatus,
    changed_by: actor.uid,
  });
  if (
    auditRes.error &&
    !/column .* does not exist|schema cache|relation .* does not exist/i.test(
      auditRes.error.message
    )
  ) {
    console.warn(
      "[orders/payment-status] audit write failed",
      auditRes.error.message
    );
  }

  return NextResponse.json({
    ok: true,
    orderId: id,
    paymentStatus,
  });
}
