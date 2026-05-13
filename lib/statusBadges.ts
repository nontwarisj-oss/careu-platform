// Centralised operational status vocabulary. Every screen that renders a
// pill / badge for order status, payment status, or sync state pulls labels
// and colour classes from here so the storefront stays visually consistent.
//
// Pure data — safe to import from server and client code.

export type OrderStatus =
  | "pending"
  | "in-progress"
  | "completed"
  | "ready-for-pickup"
  | "cancelled"
  | "overdue";

export type PaymentStatus = "unpaid" | "deposit" | "paid";

export type SyncStatus = "idle" | "syncing" | "synced" | "failed";

type BadgeSpec = {
  labelTh: string;
  labelEn: string;
  /** Tailwind classes — border + background + text. */
  classes: string;
  /** Short single-character / icon hint for ultra-compact UIs. */
  dot: string;
};

export const ORDER_STATUS_BADGES: Record<OrderStatus, BadgeSpec> = {
  pending: {
    labelTh: "รอดำเนิน",
    labelEn: "Pending",
    classes: "border-yellow-200 bg-yellow-50 text-yellow-800",
    dot: "🟡",
  },
  "in-progress": {
    labelTh: "กำลังซ่อม",
    labelEn: "In progress",
    classes: "border-blue-200 bg-blue-50 text-blue-800",
    dot: "🔵",
  },
  completed: {
    labelTh: "เสร็จสิ้น",
    labelEn: "Completed",
    classes: "border-green-200 bg-green-50 text-green-800",
    dot: "🟢",
  },
  "ready-for-pickup": {
    labelTh: "พร้อมรับ",
    labelEn: "Ready",
    classes: "border-purple-200 bg-purple-50 text-purple-800",
    dot: "🟣",
  },
  cancelled: {
    labelTh: "ยกเลิก",
    labelEn: "Cancelled",
    classes: "border-gray-200 bg-gray-50 text-gray-600 line-through",
    dot: "⚪",
  },
  overdue: {
    labelTh: "เลยกำหนด",
    labelEn: "Overdue",
    classes: "border-red-300 bg-red-50 text-red-800",
    dot: "🔴",
  },
};

export const PAYMENT_STATUS_BADGES: Record<PaymentStatus, BadgeSpec> = {
  unpaid: {
    labelTh: "ยังไม่ชำระ",
    labelEn: "Unpaid",
    classes: "border-red-200 bg-red-50 text-red-700",
    dot: "🔴",
  },
  deposit: {
    labelTh: "มัดจำ",
    labelEn: "Deposit",
    classes: "border-amber-200 bg-amber-50 text-amber-800",
    dot: "🟠",
  },
  paid: {
    labelTh: "ชำระแล้ว",
    labelEn: "Paid",
    classes: "border-green-200 bg-green-50 text-green-800",
    dot: "🟢",
  },
};

export const SYNC_STATUS_BADGES: Record<SyncStatus, BadgeSpec> = {
  idle: {
    labelTh: "รอซิงค์",
    labelEn: "Idle",
    classes: "border-gray-200 bg-gray-50 text-gray-600",
    dot: "⚪",
  },
  syncing: {
    labelTh: "กำลังซิงค์",
    labelEn: "Syncing",
    classes: "border-blue-200 bg-blue-50 text-blue-700",
    dot: "🔵",
  },
  synced: {
    labelTh: "ซิงค์แล้ว",
    labelEn: "Synced",
    classes: "border-green-200 bg-green-50 text-green-700",
    dot: "🟢",
  },
  failed: {
    labelTh: "ล้มเหลว",
    labelEn: "Failed",
    classes: "border-red-200 bg-red-50 text-red-700",
    dot: "🔴",
  },
};

/** Workflow-correct status order — useful for sorted dropdowns. */
export const ORDER_STATUS_FLOW: OrderStatus[] = [
  "pending",
  "in-progress",
  "completed",
  "ready-for-pickup",
];

export function orderStatusLabel(
  status: string,
  language: "th" | "en" = "th"
): string {
  const spec = ORDER_STATUS_BADGES[status as OrderStatus];
  if (!spec) return status;
  return language === "th" ? spec.labelTh : spec.labelEn;
}

export function orderStatusClasses(status: string): string {
  return (
    ORDER_STATUS_BADGES[status as OrderStatus]?.classes ??
    "border-gray-200 bg-gray-50 text-gray-700"
  );
}

export function paymentStatusLabel(
  status: string,
  language: "th" | "en" = "th"
): string {
  const spec = PAYMENT_STATUS_BADGES[status as PaymentStatus];
  if (!spec) return status;
  return language === "th" ? spec.labelTh : spec.labelEn;
}

export function paymentStatusClasses(status: string): string {
  return (
    PAYMENT_STATUS_BADGES[status as PaymentStatus]?.classes ??
    "border-gray-200 bg-gray-50 text-gray-700"
  );
}

/** True when an order is past its due_date and not yet delivered to the customer. */
export function isOverdue(
  status: string,
  dueDate: string | null | undefined
): boolean {
  if (!dueDate) return false;
  if (status === "ready-for-pickup" || status === "cancelled") return false;
  return new Date(dueDate) < new Date();
}
