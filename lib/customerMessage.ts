import { formatCurrency } from "@/lib/utils";
import type { BranchConfig } from "@/lib/brandConfig";
import {
  getCategoryByCode,
  getPromotionByCode,
  getServiceByCode,
} from "@/lib/pricing";

export type DocumentOrder = {
  id: string;
  customer_name: string;
  customer_phone?: string | null;
  item_name: string;
  price: number;
  subtotal: number | null;
  discount: number;
  urgent: boolean;
  urgent_fee: number;
  quantity: number;
  status: string;
  notes: string | null;
  service_category: string | null;
  service_code: string | null;
  service_name: string | null;
  template_text: string | null;
  promotion_code: string | null;
  customer_type: string | null;
  payment_status: string | null;
  created_at: string;
};

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  unpaid: "ยังไม่ชำระ",
  paid: "ชำระแล้ว",
  deposit: "มัดจำ",
};

export function formatPaymentStatus(value: string | null | undefined): string {
  if (!value) return PAYMENT_STATUS_LABEL.unpaid;
  return PAYMENT_STATUS_LABEL[value] ?? value;
}

export function serviceLabelFor(order: DocumentOrder): string {
  if (order.service_name) return order.service_name;
  const lookup = getServiceByCode(order.service_code ?? undefined);
  if (lookup) return lookup.nameTh;
  return order.item_name || "-";
}

export function categoryLabelFor(order: DocumentOrder): string | null {
  return getCategoryByCode(order.service_category ?? undefined)?.labelTh ?? null;
}

export function promotionLabelFor(order: DocumentOrder): string | null {
  if (!order.promotion_code || order.promotion_code === "NONE") return null;
  return (
    getPromotionByCode(order.promotion_code)?.nameTh ?? order.promotion_code
  );
}

/**
 * Build a customer-ready, copy-pasteable message summarising the intake +
 * quote. Plain text only — safe for LINE / SMS / clipboard.
 */
export function buildCustomerMessage(
  order: DocumentOrder,
  branch: BranchConfig,
  jobId?: string | null
): string {
  const refId = order.id.slice(0, 8).toUpperCase();
  const dateLabel = new Date(order.created_at).toLocaleDateString("th-TH", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const service = serviceLabelFor(order);
  const promo = promotionLabelFor(order);
  const subtotal =
    order.subtotal !== null
      ? order.subtotal
      : Math.max(0, order.price + (order.discount ?? 0) - (order.urgent_fee ?? 0));

  const lines: string[] = [];
  lines.push(`${branch.receiptName}`);
  lines.push(`ใบรับงาน / ใบเสนอราคา`);
  lines.push(`Job ID: ${jobId ? jobId : "ยังไม่มีรหัสงาน"}`);
  lines.push(`เลขระบบ: #${refId}`);
  lines.push(`วันที่: ${dateLabel}`);
  lines.push("");
  lines.push(`ลูกค้า: ${order.customer_name || "-"}`);
  if (order.customer_phone) {
    lines.push(`เบอร์: ${order.customer_phone}`);
  }
  lines.push("");
  lines.push(`บริการ: ${service}${order.quantity > 1 ? ` × ${order.quantity}` : ""}`);
  if (order.template_text && order.template_text.trim()) {
    lines.push(order.template_text.trim());
  }
  if (order.notes && order.notes.trim()) {
    lines.push(`บันทึก: ${order.notes.trim()}`);
  }
  lines.push("");
  lines.push(`ยอดก่อนส่วนลด: ${formatCurrency(subtotal)}`);
  if (order.urgent_fee && order.urgent_fee > 0) {
    lines.push(`ค่างานด่วน: ${formatCurrency(order.urgent_fee)}`);
  }
  if (order.discount && order.discount > 0) {
    lines.push(
      `ส่วนลด${promo ? ` (${promo})` : ""}: -${formatCurrency(order.discount)}`
    );
  }
  lines.push(`ยอดรวมสุทธิ: ${formatCurrency(order.price)}`);
  lines.push("");
  lines.push(`สถานะการชำระ: ${formatPaymentStatus(order.payment_status)}`);
  lines.push("");
  lines.push("ขั้นตอนถัดไป");
  lines.push("1. ยืนยันราคาและชำระเงิน");
  lines.push("2. ร้านรับงานเข้าระบบ");
  lines.push("3. แจ้งเมื่องานเสร็จ");
  lines.push("4. รับงานตามกำหนด");
  lines.push("");
  lines.push(`${branch.shortLabel} • ${branch.address}`);
  if (branch.tagline) {
    lines.push(branch.tagline);
  }
  return lines.join("\n");
}
