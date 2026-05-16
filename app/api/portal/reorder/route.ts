// POST /api/portal/reorder — "repair again".
//
// Phase 27A. Clones a past order into a fresh quote_requests row for
// the signed-in customer. Because the customer is authenticated, the
// quote is linked immediately (linked_customer_id) — the branch's
// triage queue sees a known customer, not an anonymous lead.
//
// The order must belong to the calling customer (verified against the
// session cookie) — a customer can only re-order their own work.

import { NextResponse } from "next/server";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONTACT_METHODS = new Set(["phone", "line", "email", "any"]);

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "portal-reorder",
    limit: 12,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "ขอเร็วเกินไป — ลองใหม่ภายหลัง" },
      { status: 429 }
    );
  }

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

  let body: { orderId?: string };
  try {
    body = (await req.json()) as { orderId?: string };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  if (!body.orderId) {
    return NextResponse.json(
      { ok: false, reason: "orderId required" },
      { status: 400 }
    );
  }

  // Load the order — and verify it belongs to THIS customer.
  const orderRes = await admin
    .from("orders")
    .select("id, customer_id, branch_id, job_id, service_name, item_name")
    .eq("id", body.orderId)
    .maybeSingle();
  const order = orderRes.data as
    | {
        id: string;
        customer_id: string | null;
        branch_id: string | null;
        job_id: string | null;
        service_name: string | null;
        item_name: string | null;
      }
    | null;
  if (!order || order.customer_id !== session.customerId) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบงาน หรือไม่ใช่งานของคุณ" },
      { status: 404 }
    );
  }

  // Pull the customer's contact details + preferences for the clone.
  const custRes = await admin
    .from("customers")
    .select(
      "name, phone, email, preferred_contact_channel, preferred_branch_id"
    )
    .eq("id", session.customerId)
    .maybeSingle();
  const customer = (custRes.data ?? {}) as {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    preferred_contact_channel?: string | null;
    preferred_branch_id?: string | null;
  };

  const phone = customer.phone ?? session.phone;
  if (!phone) {
    return NextResponse.json(
      { ok: false, reason: "ไม่มีเบอร์โทรในโปรไฟล์" },
      { status: 400 }
    );
  }
  const email =
    customer.email && customer.email !== "N/A" ? customer.email : null;
  const contactMethod =
    customer.preferred_contact_channel &&
    CONTACT_METHODS.has(customer.preferred_contact_channel)
      ? customer.preferred_contact_channel
      : "phone";
  const serviceName = order.service_name ?? order.item_name ?? "งานซ่อม";

  const ins = await admin
    .from("quote_requests")
    .insert({
      customer_name: customer.name ?? session.name ?? null,
      customer_phone: phone,
      customer_email: email,
      contact_method: contactMethod,
      branch_code: order.branch_id ?? customer.preferred_branch_id ?? null,
      service_category: serviceName,
      notes: `ขอซ่อมงานเดิมอีกครั้ง — อ้างอิงงาน ${order.job_id ?? order.id.slice(0, 8).toUpperCase()} (${serviceName})`,
      status: "new",
      // Authenticated customer — link the quote immediately.
      linked_customer_id: session.customerId,
      linked_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (ins.error || !ins.data) {
    return NextResponse.json(
      { ok: false, reason: ins.error?.message ?? "สร้างคำขอไม่สำเร็จ" },
      { status: 500 }
    );
  }

  // Best-effort customer-activity audit so the portal feed shows it.
  try {
    await admin.from("customer_activity").insert({
      customer_id: session.customerId,
      branch_id: order.branch_id,
      kind: "quote_submitted",
      payload: {
        source: "portal_reorder",
        fromOrderId: order.id,
        quoteId: (ins.data as { id: string }).id,
        service: serviceName,
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({
    ok: true,
    quoteId: (ins.data as { id: string }).id,
    service: serviceName,
  });
}
