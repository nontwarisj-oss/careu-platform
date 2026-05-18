// A4 receipt template. Extracted from /orders/[id]/document/page.tsx so the
// same JSX is reusable across pages + future PDF / preview workflows.
//
// Visual design unchanged from the prior inline version — this commit
// extracts, not redesigns. A future polish phase can refine without
// touching the data layer.
//
// The root element exposes `id="careu-receipt-card"` so lib/printService
// can target it without prop-passing.

import React from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { formatReceiptCurrency, type ReceiptData } from "@/lib/receiptData";
import {
  JobStatusBadge,
  PaymentStatusBadge,
  ReceiptNotesAndPayment,
  SHOP_BUSINESS_HOURS,
} from "@/components/receipt/ReceiptCommon";

type Props = {
  receipt: ReceiptData;
  /** Optional id override when multiple receipts coexist on a page. */
  rootId?: string;
};

export function ReceiptA4({ receipt, rootId = "careu-receipt-card" }: Props) {
  const { branch, customer, meta, items, totals, payment, notes, technicianLabel } = receipt;

  return (
    <div
      id={rootId}
      data-receipt-id={meta.fullId}
      data-receipt-mode="a4"
      className="bg-white rounded-2xl shadow-md border border-green-100 overflow-hidden"
    >
      {/* Brand header */}
      <div
        className={`bg-gradient-to-r ${branch.accentClass} px-6 py-5 border-b-4 border-yellow-400 text-white`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <BrandLogo size="lg" variant="onColor" />
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-yellow-200/90 font-semibold">
                CareU OPS • {branch.shortLabel}
              </p>
              <p className="text-lg font-bold leading-tight truncate">
                {branch.receiptName}
              </p>
              <p className="text-[11px] text-white/80 truncate">
                {branch.address}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-widest opacity-90">
              ใบรับงาน / ใบเสนอราคา
            </p>
            <p className="font-mono text-base font-bold leading-tight">
              Job ID: {meta.jobId ? meta.jobId : "ยังไม่มีรหัสงาน"}
            </p>
            <p className="font-mono text-[11px] text-white/80">
              เลขระบบ: #{meta.refId}
            </p>
            <p className="text-[11px] text-white/80 mt-0.5">
              {meta.createdAtLabel}
            </p>
            {meta.dueDate && (
              <p className="text-[11px] text-yellow-200/90 mt-0.5">
                นัดรับ: {meta.dueDate}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Customer */}
      <section className="px-6 pt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-gray-500">
            ลูกค้า
          </p>
          <p className="text-base font-semibold text-gray-800">
            {customer.name}
          </p>
          <p className="text-sm text-gray-600">{customer.phone || "-"}</p>
          {customer.typeLabel && (
            <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-800 text-[11px] font-medium">
              {customer.typeLabel}
            </span>
          )}
        </div>
        <div className="sm:text-right space-y-1">
          <p className="text-[10px] uppercase tracking-widest text-gray-500">
            สถานะงาน
          </p>
          <div>
            <JobStatusBadge status={meta.jobStatus} label={meta.jobStatusLabel} />
          </div>
          {technicianLabel && (
            <p className="text-[11px] text-gray-500">
              ช่าง: <span className="text-gray-700">{technicianLabel}</span>
            </p>
          )}
        </div>
      </section>

      {/* Service / Job */}
      <section className="px-6 mt-5 space-y-3">
        {items.map((item) => (
          <div
            key={item.id}
            className="rounded-xl border border-gray-200 bg-white p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-widest text-gray-500">
                  รายละเอียดงาน
                </p>
                {item.categoryLabel && (
                  <p className="text-[11px] text-green-700 font-semibold mt-0.5">
                    {item.categoryLabel}
                  </p>
                )}
                <p className="text-lg font-semibold text-gray-800 mt-0.5 break-words">
                  {item.serviceLabel}
                  {item.quantity > 1 && (
                    <span className="ml-2 text-sm text-gray-500">
                      × {item.quantity}
                    </span>
                  )}
                  {item.urgent && (
                    <span className="ml-2 inline-block px-2 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-700 text-[10px] font-semibold align-middle">
                      งานด่วน
                    </span>
                  )}
                </p>
              </div>
              <p className="text-right text-sm font-semibold text-green-700 whitespace-nowrap">
                {formatReceiptCurrency(item.subtotal)}
              </p>
            </div>
            {item.description && (
              <p className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">
                {item.description}
              </p>
            )}
          </div>
        ))}
        {notes && (
          <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
            <p className="text-[11px] uppercase tracking-widest text-gray-500">
              บันทึก
            </p>
            <p className="text-sm text-gray-800 whitespace-pre-wrap">{notes}</p>
          </div>
        )}
      </section>

      {/* Price summary */}
      <section className="px-6 mt-4">
        <div className="rounded-xl border border-green-200 bg-gradient-to-b from-green-50/60 to-white p-4">
          <p className="text-[10px] uppercase tracking-widest text-green-700 font-semibold mb-2">
            สรุปยอด
          </p>
          <div className="text-sm space-y-1.5">
            <div className="flex justify-between">
              <span className="text-gray-600">
                ยอดก่อนส่วนลด ({items[0]?.quantity ?? 1} ×{" "}
                {formatReceiptCurrency(items[0]?.unitPrice ?? 0)})
              </span>
              <span className="text-gray-800">
                {formatReceiptCurrency(totals.subtotal)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">ค่างานด่วน</span>
              <span className="text-gray-800">
                {formatReceiptCurrency(totals.urgentFee)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">
                ส่วนลด
                {totals.promotion ? ` (${totals.promotion.nameTh})` : ""}
              </span>
              <span className="text-gray-800">
                -{formatReceiptCurrency(totals.discount)}
              </span>
            </div>
            <div className="flex justify-between items-center pt-2 mt-1 border-t border-green-200">
              <span className="text-gray-800 font-semibold">ยอดรวมสุทธิ</span>
              <span className="text-3xl font-extrabold text-green-700 leading-none">
                {formatReceiptCurrency(totals.total)}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Payment status */}
      <section className="px-6 mt-4">
        <div className="rounded-xl border border-yellow-200 bg-yellow-50/40 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-gray-500">
              สถานะการชำระ
            </p>
            <PaymentStatusBadge
              status={payment.status}
              label={payment.statusLabel}
            />
          </div>
          <p className="text-sm text-gray-700">
            ยอดที่ต้องชำระ:{" "}
            <span className="font-bold text-green-700">
              {formatReceiptCurrency(payment.amountDue)}
            </span>
          </p>
        </div>
      </section>

      {/* Quotation notes + shop contact + payment QR / bank */}
      <section className="px-6 mt-4">
        <ReceiptNotesAndPayment />
      </section>

      {/* Next steps */}
      <section className="px-6 mt-5 pt-4 border-t border-gray-200">
        <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">
          ขั้นตอนถัดไป
        </p>
        <ol className="text-sm text-gray-700 list-decimal pl-5 space-y-1">
          <li>ยืนยันราคาและชำระเงิน</li>
          <li>ร้านรับงานเข้าระบบ</li>
          <li>แจ้งเมื่องานเสร็จ</li>
          <li>รับงานตามกำหนด</li>
        </ol>
      </section>

      {/* Footer */}
      <footer className="mt-6 bg-yellow-50 border-t border-yellow-200 px-6 py-4 text-center">
        <p className="text-sm font-medium text-gray-700">
          {branch.receiptName} • {branch.shortLabel}
        </p>
        <p className="text-xs text-gray-600">{branch.address}</p>
        <p className="text-xs text-gray-500 mt-0.5">{SHOP_BUSINESS_HOURS}</p>
        {branch.tagline && (
          <p className="text-xs text-green-700 mt-1 italic">{branch.tagline}</p>
        )}
        <p className="text-[11px] text-gray-500 mt-2">
          รับประกันงานซ่อม 7 วัน นับจากวันรับของกลับ
          (ไม่ครอบคลุมความเสียหายจากการใช้งาน)
        </p>
      </footer>
    </div>
  );
}

export default ReceiptA4;
