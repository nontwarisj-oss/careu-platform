// PATCH /api/orders/[id]/payment-status
//
// Server-side payment-status update for order documents. The browser
// Supabase client can be blocked by orders RLS when the bridge JWT/profile
// is missing, so this route performs the write with the service-role client
// after operator role + branch checks.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentUser } from "@/lib/supabaseAuth";
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
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, reason: "Not authenticated" },
      { status: 401 }
    );
  }
  if (!PAYMENT_ROLES.includes(user.role)) {
    return NextResponse.json(
      { ok: false, reason: `Role "${user.role}" cannot update payment_status` },
      { status: 403 }
    );
  }

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
    !canViewAllBranches(user.role) &&
    user.branchId !== order.branch_id
  ) {
    return NextResponse.json(
      {
        ok: false,
        reason: "Branch access denied",
        requestedBranch: order.branch_id,
        userBranch: user.branchId,
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
    changed_by: user.uid,
  });
  if (
    auditRes.error &&
    !/column .* does not exist|schema cache|relation .* does not exist/i.test(
      auditRes.error.message
    )
  ) {
    console.warn("[orders/payment-status] audit write failed", auditRes.error.message);
  }

  return NextResponse.json({
    ok: true,
    orderId: id,
    paymentStatus,
  });
}
