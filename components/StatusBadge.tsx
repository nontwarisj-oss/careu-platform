"use client";

import React from "react";
import {
  orderStatusClasses,
  orderStatusLabel,
  paymentStatusClasses,
  paymentStatusLabel,
  SYNC_STATUS_BADGES,
  type SyncStatus,
} from "@/lib/statusBadges";
import { useLanguage } from "@/lib/languageContext";

type Size = "sm" | "md";

const SIZE_CLASSES: Record<Size, string> = {
  sm: "px-2 py-0.5 text-[11px]",
  md: "px-3 py-1 text-xs",
};

interface BaseProps {
  size?: Size;
  className?: string;
}

export function OrderStatusBadge({
  status,
  size = "md",
  className,
}: BaseProps & { status: string }) {
  const { language } = useLanguage();
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border font-semibold ${
        SIZE_CLASSES[size]
      } ${orderStatusClasses(status)} ${className ?? ""}`}
    >
      {orderStatusLabel(status, language)}
    </span>
  );
}

export function PaymentStatusBadge({
  status,
  size = "md",
  className,
}: BaseProps & { status: string }) {
  const { language } = useLanguage();
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border font-semibold ${
        SIZE_CLASSES[size]
      } ${paymentStatusClasses(status)} ${className ?? ""}`}
    >
      {paymentStatusLabel(status, language)}
    </span>
  );
}

export function SyncStatusBadge({
  status,
  size = "sm",
  className,
}: BaseProps & { status: SyncStatus }) {
  const { language } = useLanguage();
  const spec = SYNC_STATUS_BADGES[status];
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border font-semibold ${
        SIZE_CLASSES[size]
      } ${spec.classes} ${className ?? ""}`}
    >
      {language === "th" ? spec.labelTh : spec.labelEn}
    </span>
  );
}
