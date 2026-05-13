import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { appendRow, readGoogleSheetsConfig } from "@/lib/googleSheets";
import { getBranchById } from "@/lib/brandConfig";
import {
  getCategoryByCode,
  getCustomerTypeByCode,
  getPromotionByCode,
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
    return NextResponse.json(
      {
        ok: false,
        reason:
          "Google Sheets sync ยังไม่ตั้งค่า credentials — เพิ่ม GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY / GOOGLE_SHEET_ID ใน environment ของ Vercel",
      },
      { status: 503 }
    );
  }

  // Fetch the order with the widest column set; fall back if any column is
  // missing so a partially-migrated DB still syncs the basics.
  const wideCols =
    "id, customer_id, customer_name, item_name, price, status, created_at, notes, urgent, urgent_fee, branch_id, subtotal, discount, quantity, service_category, service_code, service_name, template_text, customer_type, promotion_code, payment_status";
  const orderRes = await supabase
    .from("orders")
    .select(wideCols)
    .eq("id", orderId)
    .maybeSingle();

  let raw: Record<string, unknown> | null = null;
  if (!orderRes.error && orderRes.data) {
    raw = orderRes.data as unknown as Record<string, unknown>;
  } else {
    const narrow = await supabase
      .from("orders")
      .select(
        "id, customer_id, customer_name, item_name, price, status, created_at"
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

  // Pull the customer phone if we have a customer_id; missing customer is fine.
  let customerPhone: string | null = null;
  if (raw.customer_id) {
    const cust = await supabase
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

  const branchLabel = raw.branch_id
    ? getBranchById(raw.branch_id as string).shortLabel
    : "";

  const refId = String(raw.id).slice(0, 8).toUpperCase();
  const customerType = raw.customer_type
    ? getCustomerTypeByCode(raw.customer_type as string)?.nameTh ??
      (raw.customer_type as string)
    : "";
  const serviceName =
    (raw.service_name as string) ??
    getServiceByCode(raw.service_code as string | undefined)?.nameTh ??
    (raw.item_name as string) ??
    "";
  const serviceDescription =
    (raw.template_text as string) ??
    getCategoryByCode(raw.service_category as string | undefined)?.labelTh ??
    "";
  const promotion =
    raw.promotion_code && raw.promotion_code !== "NONE"
      ? getPromotionByCode(raw.promotion_code as string)?.nameTh ??
        (raw.promotion_code as string)
      : "";

  const row: Array<string | number> = [
    dateStr, // Date
    String(raw.id), // Job ID (full UUID)
    (raw.customer_name as string) ?? "", // Customer
    customerPhone ?? "", // Tel
    customerType, // Customer type
    Number(raw.quantity ?? 1), // QTY
    Number(raw.price ?? 0), // Price (net total)
    PAYMENT_LABEL[(raw.payment_status as string) ?? "unpaid"] ?? "", // Payment Status
    "", // Tech — not in schema yet
    STATUS_LABEL[(raw.status as string) ?? "pending"] ?? "", // Job Status
    "", // Due date — not in schema yet
    refId, // Ref_ID (short)
    branchLabel, // Branch
    serviceName, // Service name
    serviceDescription, // Service description
    promotion, // Promotion
    Number(raw.discount ?? 0), // Discount
    Number(raw.urgent_fee ?? 0), // Urgent fee
    Number(raw.price ?? 0), // Total (= net price for now)
  ];

  try {
    await appendRow(SHEET_TARGET, row);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        reason: (err as Error).message,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    sheet: SHEET_TARGET,
    orderId,
  });
}
