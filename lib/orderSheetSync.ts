// Order → Google Sheet sync core. Extracted from the route handler so the
// retry worker can call the same path WITHOUT re-doing role checks or
// going through HTTP. The route handler still owns auth + branch gates;
// once we're inside this function the caller is trusted.
//
// Returns a structured result either way so callers can audit the outcome.
//
// Server-only — depends on the admin client and the Sheets API.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { readGoogleSheetsConfig } from "@/lib/googleSheets";
import { writeOrderRow, type WriteRowResult } from "@/lib/sheetWriters";
import {
  getCustomerTypeByCode,
  getServiceByCode,
} from "@/lib/pricing";

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

export type SyncOrderResult =
  | {
      ok: true;
      orderId: string;
      branchCode: string | null;
      sheet: string;
      rowIndex: number;
      formatted: boolean;
      mode: WriteRowResult["mode"];
    }
  | { ok: false; orderId: string; status: number; reason: string };

/**
 * Sync one order row to the Front_Desk Google Sheet tab. Idempotent via
 * the dedup contract in `writeOrderRow` (Job ID in column B). Returns
 * `mode: "updated"` when the dedup path matched, `"appended"` otherwise.
 *
 * The function never throws — every failure is reported as
 * `{ ok: false, status, reason }` so callers can attribute the outcome
 * to a sync_failures row without losing the route handler's HTTP shape.
 */
export async function syncOrderToSheetCore(
  orderId: string
): Promise<SyncOrderResult> {
  if (!readGoogleSheetsConfig()) {
    return {
      ok: false,
      orderId,
      status: 503,
      reason: "Google Sheets sync ยังไม่ตั้งค่า credentials",
    };
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      ok: false,
      orderId,
      status: 503,
      reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า — sync ใช้งานไม่ได้",
    };
  }

  const wideCols =
    "id, customer_id, customer_name, item_name, price, status, created_at, notes, urgent, urgent_fee, branch_id, subtotal, discount, quantity, service_category, service_code, service_name, template_text, customer_type, promotion_code, payment_status";
  const wide = await admin
    .from("orders")
    .select(wideCols)
    .eq("id", orderId)
    .maybeSingle();

  let raw: Record<string, unknown> | null = null;
  if (!wide.error && wide.data) {
    raw = wide.data as unknown as Record<string, unknown>;
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
    return {
      ok: false,
      orderId,
      status: 404,
      reason: "ไม่พบใบงานในระบบ",
    };
  }

  const branchCode =
    typeof raw.branch_id === "string" ? raw.branch_id : null;

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
      paymentStatus:
        PAYMENT_LABEL[(raw.payment_status as string) ?? "unpaid"] ?? "",
      tech: "",
      jobStatus: STATUS_LABEL[(raw.status as string) ?? "pending"] ?? "",
      urgent: urgentLabel,
    });
    console.info("[order-sheet-sync] ok", {
      orderId,
      mode: result.mode,
      sheet: result.sheet,
      rowIndex: result.rowIndex,
    });
    return {
      ok: true,
      orderId,
      branchCode,
      sheet: result.sheet,
      rowIndex: result.rowIndex,
      formatted: result.formatted,
      mode: result.mode,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      orderId,
      status: 502,
      reason,
    };
  }
}
