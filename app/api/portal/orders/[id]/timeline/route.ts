// GET /api/portal/orders/[id]/timeline — customer-safe audit timeline
// for one order. Hard-checks the order's customer_id matches the
// session (same enumeration-resistant 404 pattern as the parent
// detail route).
//
// Filter rationale: order_audit_log holds every business-meaningful
// change including internal cost edits and Sheet-sync events. The
// portal shows ONLY the actions a customer would recognise: created,
// status_changed, payment_changed, cancelled. cost_updated reveals
// internal pricing math, sync_pushed/sync_failed reveal the Google
// Sheet plumbing, assigned reveals technician identity,
// receipt_regenerated is operator-only — all are excluded.

import { NextResponse } from "next/server";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CUSTOMER_SAFE_ACTIONS = new Set([
  "created",
  "status_changed",
  "payment_changed",
  "cancelled",
]);

const ACTION_LABEL: Record<string, string> = {
  created: "รับงานเข้าระบบ",
  status_changed: "อัปเดตสถานะ",
  payment_changed: "อัปเดตการชำระเงิน",
  cancelled: "ยกเลิกงาน",
};

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

function humaniseValue(action: string, raw: string | null): string | null {
  if (!raw) return null;
  if (action === "status_changed") return STATUS_LABEL[raw] ?? raw;
  if (action === "payment_changed") return PAYMENT_LABEL[raw] ?? raw;
  return null;
}

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

  const orderRes = await admin
    .from("orders")
    .select("id, customer_id, created_at")
    .eq("id", id)
    .maybeSingle();
  if (orderRes.error || !orderRes.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบงาน" },
      { status: 404 }
    );
  }
  const order = orderRes.data as {
    id: string;
    customer_id: string | null;
    created_at: string;
  };
  if (order.customer_id !== session.customerId) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบงาน" },
      { status: 404 }
    );
  }

  const auditRes = await admin
    .from("order_audit_log")
    .select("id, action, before_value, after_value, changed_at, note")
    .eq("order_id", id)
    .in("action", Array.from(CUSTOMER_SAFE_ACTIONS))
    .order("changed_at", { ascending: true });

  // If the audit table is missing or the query errors, fall back to a
  // synthetic single-entry timeline built from the order itself — the
  // customer should always see at least "งานถูกรับเข้าระบบ".
  const rows =
    auditRes.error || !auditRes.data
      ? []
      : (auditRes.data as Array<{
          id: string;
          action: string;
          before_value: string | null;
          after_value: string | null;
          changed_at: string;
          note: string | null;
        }>);

  const events = rows.map((r) => ({
    id: r.id,
    action: r.action,
    actionLabel: ACTION_LABEL[r.action] ?? r.action,
    from: humaniseValue(r.action, r.before_value),
    to: humaniseValue(r.action, r.after_value),
    changedAt: r.changed_at,
  }));

  // Guarantee the "created" entry is present. Older orders predate the
  // audit table — if the log has no 'created' row, synthesise one from
  // orders.created_at so the timeline always opens with intake.
  const hasCreated = events.some((e) => e.action === "created");
  if (!hasCreated) {
    events.unshift({
      id: `synthetic-created-${order.id}`,
      action: "created",
      actionLabel: ACTION_LABEL.created,
      from: null,
      to: null,
      changedAt: order.created_at,
    });
  }

  return NextResponse.json({ ok: true, events });
}
