import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { readGoogleSheetsConfig } from "@/lib/googleSheets";
import { writeOrderRow } from "@/lib/sheetWriters";
import { logSyncFailure } from "@/lib/syncFailures";
import {
  getCustomerTypeByCode,
  getServiceByCode,
} from "@/lib/pricing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SHEET_TARGET = process.env.GOOGLE_SHEET_ORDER_TAB ?? "Front_Desk";

const PAYMENT_LABEL: Record<string, string> = {
  unpaid: "ยังไม่ชำระ",
  paid: "ชำระแล้ว",
  deposit: "มัดจำ",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "รอดำเนิน",
  "in-progress": "กำลังซ่อม",
  completed: "เสร็จสิ้น",
  "ready-for-pickup": "พร้อมรับ",
};

export async function POST(req: Request) {
  // Require an authenticated session before reading any order. Technicians
  // sync their own orders from the document page, so they're in the allow-
  // list. Branch enforcement happens further down once we know the order's
  // branch_id.
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
    "front_staff",
    "technician",
  ]);
  if (guarded instanceof NextResponse) return guarded;

  let body: { orderId?: string };
  try {
    body = (await req.json()) as { orderId?: string };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const orderId = body.orderId;
  if (!orderId) {
    return NextResponse.json(
      { ok: false, reason: "Missing orderId" },
      { status: 400 }
    );
  }

  if (!readGoogleSheetsConfig()) {
    const missing = [
      ["GOOGLE_SERVICE_ACCOUNT_EMAIL", process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL],
      ["GOOGLE_PRIVATE_KEY", process.env.GOOGLE_PRIVATE_KEY],
      ["GOOGLE_SHEET_ID", process.env.GOOGLE_SHEET_ID],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    console.warn("[sync-order-to-sheet] missing env vars", missing);
    return NextResponse.json(
      {
        ok: false,
        reason: `Google Sheets sync ยังไม่ตั้งค่า credentials — ตัวแปรที่ขาด: ${missing.join(
          ", "
        )}`,
        missing,
      },
      { status: 503 }
    );
  }

  // Use the service-role client for the DB read. The browser-side anon client
  // would run as `anon` in this Node context (no bridge JWT is injected
  // server-side), and after the strict RLS migration that means 0 rows. We
  // re-verify branch ownership explicitly below via requireBranchAccess.
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า — sync ใช้งานไม่ได้",
      },
      { status: 503 }
    );
  }

  // Fetch the order with the widest column set; fall back if any column is
  // missing so a partially-migrated DB still syncs the basics.
  const wideCols =
    "id, customer_id, customer_name, item_name, price, status, created_at, notes, urgent, urgent_fee, branch_id, subtotal, discount, quantity, service_category, service_code, service_name, template_text, customer_type, promotion_code, payment_status";
  const orderRes = await admin
    .from("orders")
    .select(wideCols)
    .eq("id", orderId)
    .maybeSingle();

  let raw: Record<string, unknown> | null = null;
  if (!orderRes.error && orderRes.data) {
    raw = orderRes.data as unknown as Record<string, unknown>;
  } else {
    const narrow = await admin
      .from("orders")
      .select(
        "id, customer_id, customer_name, item_name, price, status, created_at, branch_id"
      )
      .eq("id", orderId)
      .maybeSingle();
    if (!narrow.error && narrow.data) {
      raw = narrow.data as unknown as Record<string, unknown>;
    }
  }

  if (!raw) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบใบงานในระบบ" },
      { status: 404 }
    );
  }

  // Branch ownership: owner / hq_admin always pass; branch-scoped roles must
  // own the order's branch. The service-role read above bypassed RLS, so this
  // check is the only enforcement.
  const orderBranchCode =
    typeof raw.branch_id === "string" ? raw.branch_id : null;
  if (orderBranchCode) {
    const branchGuard = await requireBranchAccess(orderBranchCode);
    if (branchGuard instanceof NextResponse) return branchGuard;
  }

  // Pull the customer phone if we have a customer_id; missing customer is fine.
  let customerPhone: string | null = null;
  if (raw.customer_id) {
    const cust = await admin
      .from("customers")
      .select("phone")
      .eq("id", raw.customer_id as string)
      .maybeSingle();
    if (cust.data && (cust.data as { phone?: string }).phone) {
      customerPhone = (cust.data as { phone: string }).phone;
    }
  }

  const dateIso = (raw.created_at as string) ?? new Date().toISOString();
  const dateStr = new Date(dateIso).toLocaleString("th-TH", {
    dateStyle: "short",
    timeStyle: "short",
  });

  const refId = String(raw.id).slice(0, 8).toUpperCase();
  const customerTypeLabel = raw.customer_type
    ? getCustomerTypeByCode(raw.customer_type as string)?.nameTh ??
      (raw.customer_type as string)
    : "";
  const serviceName =
    (raw.service_name as string) ??
    getServiceByCode(raw.service_code as string | undefined)?.nameTh ??
    (raw.item_name as string) ??
    "";
  const templateText = (raw.template_text as string) ?? "";
  const detail = templateText
    ? serviceName
      ? `${serviceName} — ${templateText}`
      : templateText
    : serviceName;
  const urgentFee = Number(raw.urgent_fee ?? 0);
  const urgentLabel = raw.urgent
    ? urgentFee > 0
      ? `ด่วน +฿${urgentFee}`
      : "ด่วน"
    : "";

  // Column-by-column contract is encoded in lib/sheetWriters::writeOrderRow,
  // which reads lib/sheetConfigs::SHEET_CONFIGS.front_desk for the column
  // count + template row. This route just builds the named payload.
  try {
    const result = await writeOrderRow({
      date: dateStr,
      jobId: refId,
      customerName: (raw.customer_name as string) ?? "",
      customerPhone: customerPhone ?? "",
      customerType: customerTypeLabel,
      detail,
      quantity: Number(raw.quantity ?? 1),
      price: Number(raw.price ?? 0),
      paymentStatus: PAYMENT_LABEL[(raw.payment_status as string) ?? "unpaid"] ?? "",
      tech: "",
      jobStatus: STATUS_LABEL[(raw.status as string) ?? "pending"] ?? "",
      urgent: urgentLabel,
    });
    console.info("[sync-order-to-sheet] appended", {
      orderId,
      sheet: result.sheet,
      rowIndex: result.rowIndex,
      formatted: result.formatted,
    });
    return NextResponse.json({
      ok: true,
      sheet: result.sheet,
      rowIndex: result.rowIndex,
      formatted: result.formatted,
      orderId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logSyncFailure({
      kind: "order_to_sheet",
      targetId: orderId,
      reason: message,
      payload: { sheet: SHEET_TARGET },
    });
    return NextResponse.json(
      {
        ok: false,
        reason: message,
        sheet: SHEET_TARGET,
        orderId,
      },
      { status: 502 }
    );
  }
}
