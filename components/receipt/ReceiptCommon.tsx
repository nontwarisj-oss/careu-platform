"use client";

// Shared receipt fragments used by every template (A4, thermal, mobile).
// Pure presentation — no business logic, no DB.

import React, { useState } from "react";
import type { OrderJobStatus, PaymentStatus } from "@/lib/receiptData";

export const JOB_STATUS_BADGE: Record<OrderJobStatus, string> = {
  pending: "bg-yellow-100 text-yellow-800 border-yellow-300",
  "in-progress": "bg-blue-100 text-blue-800 border-blue-300",
  completed: "bg-green-100 text-green-800 border-green-300",
  "ready-for-pickup": "bg-purple-100 text-purple-800 border-purple-300",
  cancelled: "bg-gray-100 text-gray-700 border-gray-300",
};

export const PAYMENT_STATUS_BADGE: Record<PaymentStatus, string> = {
  unpaid: "bg-yellow-100 text-yellow-800 border-yellow-300",
  deposit: "bg-blue-100 text-blue-800 border-blue-300",
  paid: "bg-green-100 text-green-800 border-green-300",
};

export function JobStatusBadge({
  status,
  label,
}: {
  status: OrderJobStatus;
  label: string;
}) {
  return (
    <span
      className={`inline-block px-3 py-1 rounded-full text-xs font-medium border ${JOB_STATUS_BADGE[status]}`}
    >
      {label}
    </span>
  );
}

export function PaymentStatusBadge({
  status,
  label,
}: {
  status: PaymentStatus;
  label: string;
}) {
  return (
    <span
      className={`inline-block px-3 py-1 rounded-full text-xs font-medium border ${PAYMENT_STATUS_BADGE[status]}`}
    >
      {label}
    </span>
  );
}

/** "Coming soon" QR placeholder — replaced by a real QR component later. */
export function QrPlaceholder({ size = 96 }: { size?: number }) {
  return (
    <div
      className="flex-shrink-0 grid place-items-center bg-yellow-50 border border-yellow-300 rounded-md text-[10px] text-gray-400 text-center leading-tight"
      style={{ width: size, height: size }}
    >
      QR
      <br />
      Code
    </div>
  );
}

// ---------- Quotation / document footer info ------------------------------
// Static shop info printed at the bottom of every receipt / quotation. The
// shop runs as a single pilot branch, so these are fixed constants — no DB
// column, no per-branch override yet.

/** Quotation terms — rendered as a numbered list under "หมายเหตุ". */
export const QUOTATION_NOTES: string[] = [
  "ราคาอาจมีการเปลี่ยนแปลง ขึ้นอยู่กับความยากง่ายของงาน",
  "ระยะเวลาในการรับงานปกติ 2-10 วัน ขึ้นอยู่กับคิวงานก่อนหน้านั้น",
  "หากทางร้านยังไม่ได้แจ้งให้ทราบว่างานเสร็จแล้ว กรุณาสอบถามเข้ามาก่อน",
  "ทางร้านมีบริการจัดส่งพัสดุให้ โดยค่าบริการจัดส่งลูกค้าเป็นผู้ชำระเอง",
];

/** Shop contact phone numbers. */
export const SHOP_CONTACT_PHONES = "094-978-2624 , 0642713052";

/** Shop business hours — printed in every receipt footer. */
export const SHOP_BUSINESS_HOURS =
  "เปิดบริการทุกวัน 08:30–17:30 (สอบถามเวลาก่อนทุกครั้ง)";

/** Shop bank account for QR / transfer payment. */
export const SHOP_BANK = {
  accountName: "นนท์วริศ เจตปิยะวัฒน์",
  bankName: "กสิกรไทย",
  accountNumber: "743-2-52142-3",
} as const;

// Drop the shop's payment QR here (public/payment-qr.png) and it appears
// automatically; until the file exists, the receipt shows a neutral
// placeholder instead of a broken image.
const QR_IMAGE_SRC = "/payment-qr.png";

/**
 * Payment QR. Renders public/payment-qr.png when present; while it loads,
 * or if it is missing (404), it falls back to the QR placeholder — so the
 * receipt never shows a broken image in print or save-as-image.
 */
function PaymentQr() {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return <QrPlaceholder size={108} />;
  return (
    <>
      {!loaded && <QrPlaceholder size={108} />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={QR_IMAGE_SRC}
        alt="QR Code สำหรับชำระเงิน"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className="rounded-md border border-gray-200"
        style={{
          width: 132,
          height: "auto",
          display: loaded ? "block" : "none",
        }}
      />
    </>
  );
}

/**
 * Bottom document box: quotation notes + shop contact (left) and the
 * payment QR + bank details (right). Pure static content, so it renders
 * identically in the browser, in print preview, and in save-as-image.
 * The two-column grid collapses to one column on a narrow receipt.
 */
export function ReceiptNotesAndPayment() {
  return (
    <div className="rounded-xl border border-gray-300 bg-white p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Left — หมายเหตุ + ติดต่อร้าน */}
        <div>
          <p className="text-sm font-bold text-gray-800">หมายเหตุ</p>
          <ol className="mt-1 list-decimal pl-5 text-xs text-gray-700 space-y-1">
            {QUOTATION_NOTES.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ol>
          <div className="mt-3 border-t border-gray-200 pt-3">
            <p className="text-[10px] uppercase tracking-widest text-gray-500">
              ติดต่อร้าน
            </p>
            <p className="text-sm text-gray-800">
              เบอร์โทรร้าน:{" "}
              <span className="font-semibold">{SHOP_CONTACT_PHONES}</span>
            </p>
          </div>
        </div>

        {/* Right — ชำระเงิน (QR + bank) */}
        <div className="sm:border-l sm:border-gray-200 sm:pl-4">
          <p className="text-[10px] uppercase tracking-widest text-gray-500">
            ชำระเงิน
          </p>
          <div className="mt-2 flex items-start gap-3">
            <PaymentQr />
            <div className="text-xs text-gray-600">
              <p className="font-medium text-gray-800">
                QR Code สำหรับชำระเงิน
              </p>
              <p className="mt-0.5">สแกนเพื่อชำระผ่านพร้อมเพย์ / ธนาคาร</p>
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs space-y-1">
            <p className="text-gray-600">
              ชื่อบัญชี:{" "}
              <span className="font-semibold text-gray-800">
                {SHOP_BANK.accountName}
              </span>
            </p>
            <p className="text-gray-600">
              ธนาคาร:{" "}
              <span className="font-semibold text-gray-800">
                {SHOP_BANK.bankName}
              </span>
            </p>
            <p className="text-gray-600">
              เลขที่บัญชี:{" "}
              <span className="font-mono font-semibold text-gray-800">
                {SHOP_BANK.accountNumber}
              </span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
