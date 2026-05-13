// Shared receipt fragments used by every template (A4, thermal, mobile).
// Pure presentation — no business logic, no DB.

import React from "react";
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
