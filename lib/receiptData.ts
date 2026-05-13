// Pure receipt data builders. Convert a raw order + customer + branch into
// a flat, render-agnostic ReceiptData object that every output channel
// (A4 print, thermal, mobile, future PDF, future LINE) consumes.
//
// Scope discipline:
//   • Pure functions only — no DB calls, no DOM, no React.
//   • One TypeScript object per "thing the customer sees": items, totals,
//     payment summary. Render layer decides how to lay them out.
//
// Server-safe (no React imports) — usable from route handlers and future
// PDF generation jobs.

import { formatCurrency } from "@/lib/utils";
import { type BranchConfig, getBranchById } from "@/lib/brandConfig";
import {
  getCustomerTypeByCode,
  type Promotion,
} from "@/lib/pricing";
import {
  categoryLabelFor,
  formatPaymentStatus,
  promotionLabelFor,
  serviceLabelFor,
  type DocumentOrder,
} from "@/lib/customerMessage";

// ---------- Domain types --------------------------------------------------

export type PaymentStatus = "unpaid" | "deposit" | "paid";

export type OrderJobStatus =
  | "pending"
  | "in-progress"
  | "completed"
  | "ready-for-pickup"
  | "cancelled";

/** One billable line on the receipt. Today orders are single-line; this
 *  shape leaves room for a multi-line future without re-modeling. */
export type ReceiptItem = {
  /** Required for keyed render. Same id for the line as the order today. */
  id: string;
  serviceCode: string | null;
  serviceLabel: string;
  /** Optional category badge ("Repair", "Alteration", …). */
  categoryLabel: string | null;
  /** Free-form description, e.g. the smart-order template text. */
  description: string | null;
  quantity: number;
  unitPrice: number;
  /** quantity × unitPrice. Pre-urgent, pre-discount. */
  subtotal: number;
  /** True when the staff toggled "งานด่วน". */
  urgent: boolean;
};

export type ReceiptTotals = {
  /** Sum of items.subtotal. */
  subtotal: number;
  urgentFee: number;
  /** Discount as a positive number; subtract from grossBeforeDiscount. */
  discount: number;
  /** Promotion that yielded the discount (or null when none). */
  promotion: Pick<Promotion, "code" | "nameTh" | "nameEn"> | null;
  /** subtotal + urgentFee. */
  grossBeforeDiscount: number;
  /** subtotal + urgentFee − discount; the customer pays this. */
  total: number;
};

export type ReceiptPayment = {
  status: PaymentStatus;
  statusLabel: string;
  /** Amount the customer still owes — 0 when paid. */
  amountDue: number;
  /** When set, render a QR code with this payload (PromptPay etc.). */
  qrPayload: string | null;
  /** Bank info to display when QR is unavailable. */
  bankName: string | null;
  /** Account name to display. */
  accountName: string;
  /** Optional account number — null until the operator fills it in. */
  accountNumber: string | null;
};

export type ReceiptCustomer = {
  name: string;
  phone: string | null;
  /** Customer type label (general / regular / VIP) for the receipt badge. */
  typeLabel: string | null;
};

export type ReceiptMeta = {
  /** First 8 chars of the order uuid, upper-cased. Always shown as "#XXX". */
  refId: string;
  /** Full uuid for QR / deep-linking / future barcode. */
  fullId: string;
  /** Human-readable job_id from orders.job_id, or null if not populated. */
  jobId: string | null;
  /** th-TH localised creation timestamp. */
  createdAtLabel: string;
  /** Due date label (YYYY-MM-DD or null). */
  dueDate: string | null;
  /** Job status — "รอดำเนิน" / "กำลังซ่อม" / etc. */
  jobStatusLabel: string;
  jobStatus: OrderJobStatus;
};

export type ReceiptData = {
  branch: BranchConfig;
  customer: ReceiptCustomer;
  meta: ReceiptMeta;
  items: ReceiptItem[];
  totals: ReceiptTotals;
  payment: ReceiptPayment;
  /** Free-form notes shown beneath the items. */
  notes: string | null;
  /** Free-form technician label (orders.tech or assigned name). null if blank. */
  technicianLabel: string | null;
};

// ---------- Builders ------------------------------------------------------

const JOB_STATUS_TH: Record<string, string> = {
  pending: "รอดำเนิน",
  "in-progress": "กำลังซ่อม",
  completed: "เสร็จสิ้น",
  "ready-for-pickup": "พร้อมรับ",
  cancelled: "ยกเลิก",
};

const BANK_FALLBACK = {
  bankName: null,
  accountName: "",
  accountNumber: null,
};

function asJobStatus(value: string | null | undefined): OrderJobStatus {
  switch (value) {
    case "in-progress":
    case "completed":
    case "ready-for-pickup":
    case "cancelled":
      return value;
    default:
      return "pending";
  }
}

function asPaymentStatus(value: string | null | undefined): PaymentStatus {
  if (value === "paid" || value === "deposit") return value;
  return "unpaid";
}

export type BuildReceiptInput = {
  order: DocumentOrder;
  branchId?: string | null;
  /** Optional override when the order does not have a phone column populated. */
  customerPhone?: string | null;
  /** Job id (from orders.job_id) if available. */
  jobId?: string | null;
  /** Due date (YYYY-MM-DD) if available. */
  dueDate?: string | null;
  /** Free-form technician label (from orders.tech or assigned tech). */
  technicianLabel?: string | null;
};

/**
 * The single entry point. Takes the raw order + the branch context + a
 * couple of optional auxiliary fields and produces the flat receipt object.
 * Render components consume this shape and decide how to lay it out.
 */
export function buildReceiptData(input: BuildReceiptInput): ReceiptData {
  const { order } = input;
  const branch = getBranchById(input.branchId ?? null);
  const items = buildReceiptItems(order);
  const totals = buildReceiptTotals(order);
  const payment = buildPaymentSummary(order, branch);

  return {
    branch,
    customer: {
      name: order.customer_name || "-",
      phone: order.customer_phone ?? input.customerPhone ?? null,
      typeLabel:
        getCustomerTypeByCode(order.customer_type ?? undefined)?.nameTh ??
        null,
    },
    meta: {
      refId: order.id.slice(0, 8).toUpperCase(),
      fullId: order.id,
      jobId: input.jobId ?? null,
      createdAtLabel: new Date(order.created_at).toLocaleString("th-TH", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
      dueDate: input.dueDate ?? null,
      jobStatusLabel: JOB_STATUS_TH[order.status] ?? order.status,
      jobStatus: asJobStatus(order.status),
    },
    items,
    totals,
    payment,
    notes: order.notes,
    technicianLabel: input.technicianLabel ?? null,
  };
}

/**
 * One item per order today. Multi-line orders would extend this loop.
 */
export function buildReceiptItems(order: DocumentOrder): ReceiptItem[] {
  const subtotal =
    order.subtotal !== null && order.subtotal !== undefined
      ? Number(order.subtotal)
      : Math.max(
          0,
          Number(order.price ?? 0) +
            Number(order.discount ?? 0) -
            Number(order.urgent_fee ?? 0)
        );
  const quantity = Math.max(1, Number(order.quantity ?? 1));
  const unitPrice = quantity > 0 ? subtotal / quantity : 0;
  return [
    {
      id: order.id,
      serviceCode: order.service_code,
      serviceLabel: serviceLabelFor(order),
      categoryLabel: categoryLabelFor(order),
      description: order.template_text,
      quantity,
      unitPrice,
      subtotal,
      urgent: !!order.urgent,
    },
  ];
}

/**
 * Total math. Mirrors what /pricing's calculateFinalPrice produces but
 * works off the persisted order (post-save) rather than the live form.
 */
export function buildReceiptTotals(order: DocumentOrder): ReceiptTotals {
  const items = buildReceiptItems(order);
  const subtotal = items.reduce((s, item) => s + item.subtotal, 0);
  const urgentFee = Math.max(0, Number(order.urgent_fee ?? 0));
  const discount = Math.max(0, Number(order.discount ?? 0));
  const grossBeforeDiscount = subtotal + urgentFee;
  const total = Number(order.price ?? 0);
  const promotionLabel = promotionLabelFor(order);
  const promotion = promotionLabel
    ? {
        code: order.promotion_code ?? "MANUAL",
        nameTh: promotionLabel,
        nameEn: promotionLabel,
      }
    : null;
  return {
    subtotal,
    urgentFee,
    discount,
    promotion,
    grossBeforeDiscount,
    total,
  };
}

/**
 * Payment block. Today the QR payload + bank account are not in the
 * branches table — leave them as null so the render layer shows a
 * "fill me in" placeholder. Future: per-branch QR / account on
 * public.branches.
 */
export function buildPaymentSummary(
  order: DocumentOrder,
  branch: BranchConfig
): ReceiptPayment {
  const status = asPaymentStatus(order.payment_status);
  const total = Number(order.price ?? 0);
  const amountDue =
    status === "paid" ? 0 : status === "deposit" ? Math.max(0, total / 2) : total;
  return {
    status,
    statusLabel: formatPaymentStatus(status),
    amountDue,
    qrPayload: null,
    bankName: BANK_FALLBACK.bankName,
    accountName: branch.receiptName,
    accountNumber: BANK_FALLBACK.accountNumber,
  };
}

// ---------- Pretty-printers (used by all template components) ------------

export function formatReceiptCurrency(amount: number): string {
  return formatCurrency(Number.isFinite(amount) ? amount : 0);
}
