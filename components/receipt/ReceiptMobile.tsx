// Mobile receipt — single-column, full-width, large-touch-target layout
// optimised for an in-store tablet OR a customer LINE chat (when sent as
// an image via saveReceiptAsImage). Uses the same data as ReceiptA4 but
// drops the two-column sections so phone-width screens render cleanly.

import React from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { formatReceiptCurrency, type ReceiptData } from "@/lib/receiptData";
import {
  JobStatusBadge,
  PaymentStatusBadge,
  QrPlaceholder,
} from "@/components/receipt/ReceiptCommon";

type Props = {
  receipt: ReceiptData;
  rootId?: string;
};

export function ReceiptMobile({ receipt, rootId = "careu-receipt-card" }: Props) {
  const { branch, customer, meta, items, totals, payment, notes, technicianLabel } = receipt;
  return (
    <div
      id={rootId}
      data-receipt-id={meta.fullId}
      data-receipt-mode="mobile"
      className="bg-white rounded-2xl shadow-md border border-green-100 overflow-hidden max-w-md mx-auto"
    >
      <div
        className={`bg-gradient-to-r ${branch.accentClass} px-4 py-4 border-b-4 border-yellow-400 text-white`}
      >
        <div className="flex items-center gap-3">
          <BrandLogo size="md" variant="onColor" />
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-yellow-200/90 font-semibold">
              {branch.shortLabel}
            </p>
            <p className="text-base font-bold leading-tight">
              {branch.receiptName}
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-end justify-between gap-2">
          <div>
            <p className="text-[10px] uppercase tracking-widest opacity-90">
              ใบรับงาน
            </p>
            <p className="font-mono text-sm">
              {meta.jobId ? meta.jobId : `#${meta.refId}`}
            </p>
          </div>
          <p className="text-[11px] text-white/80">{meta.createdAtLabel}</p>
        </div>
      </div>

      <section className="px-4 py-3 space-y-1 border-b border-gray-100">
        <p className="text-[11px] text-gray-500">ลูกค้า</p>
        <p className="text-base font-semibold text-gray-800">{customer.name}</p>
        <p className="text-sm text-gray-600">{customer.phone || "-"}</p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {customer.typeLabel && (
            <span className="px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-800 text-[11px] font-medium">
              {customer.typeLabel}
            </span>
          )}
          <JobStatusBadge status={meta.jobStatus} label={meta.jobStatusLabel} />
        </div>
        {technicianLabel && (
          <p className="text-[11px] text-gray-500 pt-1">
            ช่าง: <span className="text-gray-700">{technicianLabel}</span>
          </p>
        )}
      </section>

      <section className="px-4 py-3 space-y-3 border-b border-gray-100">
        {items.map((item) => (
          <div key={item.id} className="space-y-1">
            {item.categoryLabel && (
              <p className="text-[11px] text-green-700 font-semibold">
                {item.categoryLabel}
              </p>
            )}
            <div className="flex items-start justify-between gap-2">
              <p className="text-base font-medium text-gray-900 break-words">
                {item.serviceLabel}
                {item.quantity > 1 && (
                  <span className="ml-2 text-xs text-gray-500">
                    × {item.quantity}
                  </span>
                )}
                {item.urgent && (
                  <span className="ml-2 inline-block px-1.5 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-700 text-[10px] font-semibold align-middle">
                    งานด่วน
                  </span>
                )}
              </p>
              <p className="text-sm font-semibold text-green-700 whitespace-nowrap">
                {formatReceiptCurrency(item.subtotal)}
              </p>
            </div>
            {item.description && (
              <p className="text-xs text-gray-600 whitespace-pre-wrap">
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

      <section className="px-4 py-3 border-b border-gray-100">
        <div className="text-sm space-y-1.5">
          <div className="flex justify-between">
            <span className="text-gray-600">ยอดก่อนส่วนลด</span>
            <span className="text-gray-800">
              {formatReceiptCurrency(totals.subtotal)}
            </span>
          </div>
          {totals.urgentFee > 0 && (
            <div className="flex justify-between">
              <span className="text-gray-600">ค่างานด่วน</span>
              <span className="text-gray-800">
                +{formatReceiptCurrency(totals.urgentFee)}
              </span>
            </div>
          )}
          {totals.discount > 0 && (
            <div className="flex justify-between">
              <span className="text-gray-600">
                ส่วนลด
                {totals.promotion ? ` (${totals.promotion.nameTh})` : ""}
              </span>
              <span className="text-gray-800">
                -{formatReceiptCurrency(totals.discount)}
              </span>
            </div>
          )}
          <div className="flex justify-between items-center pt-2 mt-1 border-t border-gray-200">
            <span className="text-gray-800 font-semibold">ยอดรวมสุทธิ</span>
            <span className="text-2xl font-extrabold text-green-700 leading-none">
              {formatReceiptCurrency(totals.total)}
            </span>
          </div>
        </div>
      </section>

      <section className="px-4 py-3 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <QrPlaceholder size={72} />
          <div className="text-xs text-gray-600 space-y-1">
            <p className="font-medium text-gray-700">ชำระผ่าน QR</p>
            <p>
              บัญชี: <span className="text-gray-800">{payment.accountName}</span>
            </p>
            <p>
              เลขที่บัญชี:{" "}
              <span className="text-gray-800">
                {payment.accountNumber ?? "ระบุภายหลัง"}
              </span>
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <PaymentStatusBadge
            status={payment.status}
            label={payment.statusLabel}
          />
          <p className="text-sm text-gray-700">
            ต้องชำระ:{" "}
            <span className="font-bold text-green-700">
              {formatReceiptCurrency(payment.amountDue)}
            </span>
          </p>
        </div>
      </section>

      <footer className="bg-yellow-50 border-t border-yellow-200 px-4 py-3 text-center">
        <p className="text-sm font-medium text-gray-700">
          {branch.receiptName}
        </p>
        <p className="text-[11px] text-gray-600">{branch.address}</p>
        {branch.tagline && (
          <p className="text-[11px] text-green-700 mt-1 italic">
            {branch.tagline}
          </p>
        )}
        <p className="text-[10px] text-gray-500 mt-1">
          รับประกันงานซ่อม 7 วัน นับจากวันรับของกลับ
        </p>
      </footer>
    </div>
  );
}

export default ReceiptMobile;
