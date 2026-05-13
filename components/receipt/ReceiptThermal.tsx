// Thermal receipt template — 80mm strip layout suitable for ESC/POS-style
// receipt printers. Monospace, narrow column, no colour, no images.
//
// Sizing rules:
//   • Width: ~72mm visible (80mm paper − margins). Set via .receipt-thermal
//     in globals.css under @media print so the browser scales to fit.
//   • Font: monospace, ~10pt. Most thermal printers render ~32–48 cols
//     wide; we target 32 visible chars per line.
//
// This template carries the same data as ReceiptA4 but renders flat,
// text-only output so a customer-facing thermal print looks like a
// proper retail receipt.

import React from "react";
import { formatReceiptCurrency, type ReceiptData } from "@/lib/receiptData";

type Props = {
  receipt: ReceiptData;
  rootId?: string;
};

const HR = "─".repeat(32);

export function ReceiptThermal({ receipt, rootId = "careu-receipt-card" }: Props) {
  const { branch, customer, meta, items, totals, payment, technicianLabel } = receipt;

  return (
    <div
      id={rootId}
      data-receipt-id={meta.fullId}
      data-receipt-mode="thermal"
      className="receipt-thermal bg-white text-black font-mono text-[12px] leading-tight px-3 py-3 mx-auto"
      style={{ width: "80mm", maxWidth: "100%" }}
    >
      <pre className="whitespace-pre-wrap font-mono text-[12px] leading-tight">
        {`${centerLine(branch.receiptName.toUpperCase(), 32)}\n`}
        {`${centerLine(branch.shortLabel, 32)}\n`}
        {`${centerLine(branch.address, 32)}\n`}
        {HR}
        {`\nใบรับงาน / ใบเสนอราคา\n`}
        {`${padPair("Job ID", meta.jobId ?? `#${meta.refId}`, 32)}\n`}
        {`${padPair("วันที่", meta.createdAtLabel, 32)}\n`}
        {meta.dueDate ? `${padPair("นัดรับ", meta.dueDate, 32)}\n` : ""}
        {`${padPair("สถานะ", meta.jobStatusLabel, 32)}\n`}
        {HR}
        {`\n${padPair("ลูกค้า", customer.name, 32)}\n`}
        {customer.phone ? `${padPair("เบอร์", customer.phone, 32)}\n` : ""}
        {technicianLabel ? `${padPair("ช่าง", technicianLabel, 32)}\n` : ""}
        {HR}
        {`\nรายการ\n`}
        {items.map((item) => {
          const qtyStr = `${item.quantity} × ${formatReceiptCurrency(item.unitPrice)}`;
          return (
            `${truncate(item.serviceLabel, 32)}\n` +
            `${padPair(`  ${qtyStr}`, formatReceiptCurrency(item.subtotal), 32)}\n` +
            (item.urgent ? `  [งานด่วน]\n` : "")
          );
        }).join("")}
        {HR}
        {`\n${padPair("ยอดก่อนส่วนลด", formatReceiptCurrency(totals.subtotal), 32)}\n`}
        {totals.urgentFee > 0
          ? `${padPair("ค่างานด่วน", `+${formatReceiptCurrency(totals.urgentFee)}`, 32)}\n`
          : ""}
        {totals.discount > 0
          ? `${padPair(
              totals.promotion ? `ส่วนลด (${totals.promotion.nameTh})` : "ส่วนลด",
              `-${formatReceiptCurrency(totals.discount)}`,
              32
            )}\n`
          : ""}
        {HR}
        {`\n${padPair("ยอดรวมสุทธิ", formatReceiptCurrency(totals.total), 32)}\n`}
        {HR}
        {`\n${padPair("สถานะชำระ", payment.statusLabel, 32)}\n`}
        {payment.amountDue > 0
          ? `${padPair("ยอดต้องชำระ", formatReceiptCurrency(payment.amountDue), 32)}\n`
          : ""}
        {`\n${centerLine(branch.tagline || "ขอบคุณที่ใช้บริการ", 32)}\n`}
        {`${centerLine(`รับประกันซ่อม 7 วัน`, 32)}\n`}
      </pre>
    </div>
  );
}

function padPair(left: string, right: string, width: number): string {
  const r = right ?? "";
  const space = Math.max(1, width - left.length - r.length);
  if (space <= 0) {
    return `${left}\n${r.padStart(width)}`;
  }
  return `${left}${" ".repeat(space)}${r}`;
}

function centerLine(text: string, width: number): string {
  if (!text) return "";
  if (text.length >= width) return text.slice(0, width);
  const pad = Math.floor((width - text.length) / 2);
  return `${" ".repeat(pad)}${text}`;
}

function truncate(text: string, width: number): string {
  if (!text) return "";
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

export default ReceiptThermal;
