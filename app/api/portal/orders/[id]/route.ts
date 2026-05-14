// GET /api/portal/orders/[id] — single order detail for the signed-in
// customer. Hard-checks that the order's customer_id matches the
// session. Returns the same customer-safe column subset as the list,
// plus extra fields the receipt view needs (subtotal, discount,
// urgent_fee, quantity, template_text).
//
// Internal fields NOT returned: labor_cost, material_cost,
// assigned_technician_id, tech, notes (operator-internal), promotion
// code, audit columns.

import { NextResponse } from "next/server";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_LABEL: Record<string, string> = {
  pending: "รอดำเนิน",
  "in-progress": "กำลังซ่อม",
  completed: "เสร็จสิ้น",
  "ready-for-pickup": "พร้อมรับ",
  cancelled: "ยกเลิก",
};
const PAYMENT_LABEL: Record<string, string> = {
  unpaid: "ยังไม่ชำระ",
  deposit: "มัดจำแล้ว",
  paid: "ชำระแล้ว",
};

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const session = await readCustomerSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, reason: "ยังไม่ได้เข้าสู่ระบบ" },
      { status: 401 }
    );
  }
  const { id } = await context.params;
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  const res = await admin
    .from("orders")
    .select(
      "id, job_id, customer_id, branch_id, status, payment_status, service_category, service_code, service_name, item_name, template_text, quantity, price, subtotal, discount, urgent, urgent_fee, due_date, created_at"
    )
    .eq("id", id)
    .maybeSingle();
  if (res.error || !res.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบงาน" },
      { status: 404 }
    );
  }
  const row = res.data as Record<string, unknown>;
  // Hard customer-id match. Wrong-owner attempts get the SAME 404
  // response as a missing id — no information leak about which orders
  // exist for other customers.
  if (row.customer_id !== session.customerId) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบงาน" },
      { status: 404 }
    );
  }

  let branchLabel: string | null = null;
  const branchSlug = (row.branch_id as string) ?? null;
  if (branchSlug) {
    const branchRes = await admin
      .from("branches")
      .select("short_label, short_name, name")
      .eq("code", branchSlug)
      .maybeSingle();
    const branch = branchRes.data as
      | { short_label: string | null; short_name: string | null; name: string }
      | null;
    branchLabel =
      branch?.short_label ?? branch?.short_name ?? branch?.name ?? null;
  }

  return NextResponse.json({
    ok: true,
    order: {
      id: row.id,
      refId: String(row.id).slice(0, 8).toUpperCase(),
      jobId: (row.job_id as string) ?? null,
      branchLabel,
      status: row.status,
      statusLabel: STATUS_LABEL[(row.status as string) ?? "pending"] ?? row.status,
      paymentStatus: row.payment_status,
      paymentLabel: PAYMENT_LABEL[(row.payment_status as string) ?? "unpaid"] ?? row.payment_status,
      serviceCategory: row.service_category ?? null,
      serviceCode: row.service_code ?? null,
      service: row.service_name ?? row.item_name ?? "งานซ่อม",
      templateText: row.template_text ?? null,
      quantity: Number(row.quantity ?? 1),
      price: Number(row.price ?? 0),
      subtotal:
        row.subtotal === null || row.subtotal === undefined
          ? null
          : Number(row.subtotal),
      discount: Number(row.discount ?? 0),
      urgent: !!row.urgent,
      urgentFee: Number(row.urgent_fee ?? 0),
      dueDate: row.due_date ?? null,
      createdAt: row.created_at,
    },
  });
}
