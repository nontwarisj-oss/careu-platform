// Pure builders for the four MVP customer messages. No DB, no DOM, no
// React. Reused by the delivery orchestrator (server) and the future
// "preview before send" admin UI.
//
// Style notes:
//   • Plain Thai text in the MVP. Customers see the message as a normal
//     LINE chat bubble.
//   • Branding stays minimal — branch.receiptName + Job ID + status.
//     The receipt image (future Flex Message) carries the full visual
//     identity.
//   • Lines kept short (<= ~60 chars) so phone chat bubbles wrap nicely.

import type { BranchConfig } from "@/lib/brandConfig";
import { formatCurrency } from "@/lib/utils";
import {
  buildCustomerMessage,
  serviceLabelFor,
  type DocumentOrder,
} from "@/lib/customerMessage";

export type MessageBuildInput = {
  order: DocumentOrder;
  branch: BranchConfig;
  /** Optional human-readable Job ID (from orders.job_id), falls back to refId. */
  jobId?: string | null;
  /** Optional due date (YYYY-MM-DD) for pickup reminders. */
  dueDate?: string | null;
};

export type BuiltMessage = {
  /** Full text body to send. */
  text: string;
  /** Kind hint useful for the orchestrator's log row. */
  kind: "order_received" | "order_ready" | "pickup_reminder" | "receipt";
};

function refLine(order: DocumentOrder, jobId: string | null | undefined): string {
  if (jobId && jobId.trim()) return `เลขที่: ${jobId}`;
  return `เลขที่: #${order.id.slice(0, 8).toUpperCase()}`;
}

function joinLines(parts: string[]): string {
  return parts.filter((p) => p && p.trim().length > 0).join("\n");
}

// ---------- 1. Order received ---------------------------------------------

/**
 * Sent immediately after the staff creates an order at /intake. Tells the
 * customer "your job is in our queue". Short, no payment ask — that's a
 * separate message when status flips to ready.
 */
export function buildOrderReceivedMessage(input: MessageBuildInput): BuiltMessage {
  const { order, branch, jobId } = input;
  const service = serviceLabelFor(order);
  return {
    kind: "order_received",
    text: joinLines([
      `${branch.receiptName} ขอบคุณที่ใช้บริการ`,
      `รับงานเข้าระบบเรียบร้อย`,
      ``,
      refLine(order, jobId),
      `งาน: ${service}${order.quantity > 1 ? ` × ${order.quantity}` : ""}`,
      `ยอดประเมิน: ${formatCurrency(order.price)}`,
      input.dueDate ? `นัดรับ: ${input.dueDate}` : "",
      ``,
      `เราจะแจ้งอีกครั้งเมื่องานเสร็จ`,
      `${branch.shortLabel} • ${branch.address}`,
    ]),
  };
}

// ---------- 2. Order ready -------------------------------------------------

/**
 * Sent when status changes to 'completed' or 'ready-for-pickup'.
 * Includes the outstanding balance so the customer can come prepared.
 */
export function buildOrderReadyMessage(input: MessageBuildInput): BuiltMessage {
  const { order, branch, jobId } = input;
  const service = serviceLabelFor(order);
  const paymentStatus = order.payment_status ?? "unpaid";
  const owed = paymentStatus === "paid" ? 0 : Number(order.price ?? 0);
  return {
    kind: "order_ready",
    text: joinLines([
      `${branch.receiptName}`,
      `งานของคุณเสร็จเรียบร้อย — รับได้ที่ร้าน`,
      ``,
      refLine(order, jobId),
      `งาน: ${service}${order.quantity > 1 ? ` × ${order.quantity}` : ""}`,
      owed > 0
        ? `ยอดที่ต้องชำระ: ${formatCurrency(owed)}`
        : `ชำระเรียบร้อย`,
      ``,
      `เวลาทำการ จันทร์–เสาร์ 09:00–18:00`,
      `${branch.shortLabel} • ${branch.address}`,
    ]),
  };
}

// ---------- 3. Pickup reminder ---------------------------------------------

/**
 * Polite nudge when the order has been ready for a while. Tone is softer
 * than the ready message so we don't annoy customers.
 */
export function buildPickupReminderMessage(input: MessageBuildInput): BuiltMessage {
  const { order, branch, jobId, dueDate } = input;
  const service = serviceLabelFor(order);
  return {
    kind: "pickup_reminder",
    text: joinLines([
      `${branch.receiptName}`,
      `แจ้งเตือน — งานยังรอลูกค้ามารับ`,
      ``,
      refLine(order, jobId),
      `งาน: ${service}${order.quantity > 1 ? ` × ${order.quantity}` : ""}`,
      dueDate ? `กำหนดรับ: ${dueDate}` : "",
      ``,
      `สะดวกแวะรับวันนี้ได้ไหม? เรารอคุณอยู่`,
      `${branch.shortLabel} • ${branch.address}`,
    ]),
  };
}

// ---------- 4. Receipt delivery (text fallback) ----------------------------

/**
 * Text-only receipt body. Used when the image-based receipt push (future
 * Flex Message via lib/printService::sendReceiptViaLine) isn't yet wired
 * for a given branch. Built from `buildCustomerMessage` so the wording
 * stays consistent with the existing "copy message" button on the
 * document page.
 */
export function buildReceiptMessage(input: MessageBuildInput): BuiltMessage {
  return {
    kind: "receipt",
    text: buildCustomerMessage(input.order, input.branch, input.jobId),
  };
}
