// LINE OA delivery orchestrator. Server-only.
//
// One entry point per message kind:
//   • sendOrderCreatedMessage(orderId)
//   • sendOrderReadyMessage(orderId)
//   • sendPickupReminderMessage(orderId)
//   • sendReceiptMessage(orderId)
//
// Each orchestrator function:
//   1. Reads the order + customer + branch using the service-role client
//      so it works regardless of which JWT the caller carried.
//   2. Looks up the customer's LINE link + checks notification prefs +
//      unsubscribed state. Skips with status='skipped' when no link.
//   3. Resolves the LINE channel config (per-branch DB row → env fallback).
//      503-like skip when no config at all.
//   4. Builds the message body via lib/lineMessageBuilders.
//   5. Pushes via lib/lineMessaging.pushTextMessage.
//   6. Records the attempt in public.line_message_log regardless of
//      outcome — sent / failed / skipped / pending.
//
// Returns a DeliveryResult so the route handler can render a friendly
// status badge. Errors NEVER throw to the caller; the order workflow
// must keep running even when LINE is down.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { logSyncFailure } from "@/lib/syncFailures";
import {
  resolveLineChannelConfig,
  type LineChannelConfig,
} from "@/lib/lineConfig";
import { pushTextMessage } from "@/lib/lineMessaging";
import {
  buildOrderReceivedMessage,
  buildOrderReadyMessage,
  buildPickupReminderMessage,
  buildReceiptMessage,
  type BuiltMessage,
  type MessageBuildInput,
} from "@/lib/lineMessageBuilders";
import { getBranchById } from "@/lib/brandConfig";
import type { DocumentOrder } from "@/lib/customerMessage";

export type LineMessageKind = BuiltMessage["kind"];

export type DeliveryResult =
  | {
      ok: true;
      status: "sent";
      kind: LineMessageKind;
      lineUserId: string;
      requestId: string | null;
      logId: string | null;
    }
  | {
      ok: false;
      status: "skipped" | "failed";
      kind: LineMessageKind;
      reason: string;
      logId: string | null;
    };

export type DeliveryContext = {
  /** profiles.id of the staff member triggering the send. */
  actorId?: string | null;
};

// ---------- Public API ----------------------------------------------------

export async function sendOrderCreatedMessage(
  orderId: string,
  ctx: DeliveryContext = {}
): Promise<DeliveryResult> {
  return runDelivery(orderId, "order_received", buildOrderReceivedMessage, ctx);
}

export async function sendOrderReadyMessage(
  orderId: string,
  ctx: DeliveryContext = {}
): Promise<DeliveryResult> {
  return runDelivery(orderId, "order_ready", buildOrderReadyMessage, ctx);
}

export async function sendPickupReminderMessage(
  orderId: string,
  ctx: DeliveryContext = {}
): Promise<DeliveryResult> {
  return runDelivery(orderId, "pickup_reminder", buildPickupReminderMessage, ctx);
}

export async function sendReceiptMessage(
  orderId: string,
  ctx: DeliveryContext = {}
): Promise<DeliveryResult> {
  return runDelivery(orderId, "receipt", buildReceiptMessage, ctx);
}

// ---------- Implementation ------------------------------------------------

type Builder = (input: MessageBuildInput) => BuiltMessage;

type OrderRow = DocumentOrder & {
  branch_id: string | null; // text slug
  job_id: string | null;
  due_date: string | null;
  customer_id: string | null;
};

type LinkedCustomer = {
  customer_id: string | null;
  line_user_id: string;
  prefs: {
    order_received: boolean;
    order_ready: boolean;
    pickup_reminder: boolean;
    receipt: boolean;
  };
  unsubscribed: boolean;
};

async function runDelivery(
  orderId: string,
  kind: LineMessageKind,
  builder: Builder,
  ctx: DeliveryContext
): Promise<DeliveryResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return skip(kind, null, "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า");
  }

  const order = await fetchOrder(orderId);
  if (!order) {
    return skip(kind, null, "ไม่พบใบงานในระบบ");
  }

  const branch = order.branch_id ? getBranchById(order.branch_id) : null;
  if (!branch) {
    return skip(kind, order.branch_id, "ใบงานไม่ระบุสาขา");
  }

  const link = await fetchCustomerLineLink(order.customer_id);
  if (!link) {
    return logAndSkip(
      kind,
      order,
      null,
      "ลูกค้ายังไม่ได้ผูก LINE OA กับใบงานนี้",
      ctx
    );
  }
  if (link.unsubscribed) {
    return logAndSkip(
      kind,
      order,
      link,
      "ลูกค้าได้ยกเลิกการรับข้อความแล้ว",
      ctx
    );
  }
  if (!prefForKind(link.prefs, kind)) {
    return logAndSkip(
      kind,
      order,
      link,
      "ลูกค้าปิดการรับข้อความประเภทนี้",
      ctx
    );
  }

  // Resolve channel config — needs branches.id (uuid), not the text slug.
  const branchUuid = await resolveBranchUuid(order.branch_id);
  const channel = await resolveLineChannelConfig(branchUuid);
  if (!channel) {
    return logAndSkip(
      kind,
      order,
      link,
      "LINE OA ยังไม่ตั้งค่า — ขาด LINE_CHANNEL_ACCESS_TOKEN",
      ctx
    );
  }

  // Build + send
  const message = builder({
    order,
    branch,
    jobId: order.job_id,
    dueDate: order.due_date,
  });
  const pushed = await pushTextMessage(channel, link.line_user_id, message.text);

  // Log the attempt
  const logId = await writeMessageLog({
    kind,
    order,
    link,
    branchCode: order.branch_id,
    channel,
    messageText: message.text,
    status: pushed.ok ? "sent" : "failed",
    errorReason: pushed.ok ? null : pushed.reason,
    sentAt: pushed.ok ? new Date().toISOString() : null,
    actorId: ctx.actorId ?? null,
  });

  if (!pushed.ok) {
    logSyncFailure({
      kind: "line_send",
      targetId: orderId,
      branchId: order.branch_id,
      reason: `LINE ${pushed.status}: ${pushed.reason}`,
      payload: { messageKind: kind, lineUserId: link.line_user_id },
    });
    return {
      ok: false,
      status: "failed",
      kind,
      reason: pushed.reason,
      logId,
    };
  }
  return {
    ok: true,
    status: "sent",
    kind,
    lineUserId: link.line_user_id,
    requestId: pushed.requestId,
    logId,
  };
}

// ---------- Helpers -------------------------------------------------------

function prefForKind(
  prefs: LinkedCustomer["prefs"],
  kind: LineMessageKind
): boolean {
  switch (kind) {
    case "order_received":
      return prefs.order_received;
    case "order_ready":
      return prefs.order_ready;
    case "pickup_reminder":
      return prefs.pickup_reminder;
    case "receipt":
      return prefs.receipt;
  }
}

async function fetchOrder(orderId: string): Promise<OrderRow | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const cols =
    "id, customer_id, customer_name, item_name, price, status, created_at, notes, urgent, urgent_fee, branch_id, subtotal, discount, quantity, service_category, service_code, service_name, template_text, customer_type, promotion_code, payment_status, job_id, due_date";
  const res = await admin.from("orders").select(cols).eq("id", orderId).maybeSingle();
  if (res.error || !res.data) return null;
  const raw = res.data as Record<string, unknown>;

  // Resolve customer phone
  let phone: string | null = null;
  if (raw.customer_id) {
    const c = await admin
      .from("customers")
      .select("phone")
      .eq("id", raw.customer_id as string)
      .maybeSingle();
    if (c.data && (c.data as { phone?: string }).phone) {
      phone = (c.data as { phone: string }).phone;
    }
  }

  return {
    id: String(raw.id),
    customer_name: (raw.customer_name as string) ?? "",
    customer_phone: phone,
    item_name: (raw.item_name as string) ?? "",
    price: Number(raw.price ?? 0),
    subtotal:
      raw.subtotal !== null && raw.subtotal !== undefined
        ? Number(raw.subtotal)
        : null,
    discount: Number(raw.discount ?? 0),
    urgent: Boolean(raw.urgent),
    urgent_fee: Number(raw.urgent_fee ?? 0),
    quantity: Number(raw.quantity ?? 1),
    status: (raw.status as string) ?? "pending",
    notes: (raw.notes as string) ?? null,
    service_category: (raw.service_category as string) ?? null,
    service_code: (raw.service_code as string) ?? null,
    service_name: (raw.service_name as string) ?? null,
    template_text: (raw.template_text as string) ?? null,
    customer_type: (raw.customer_type as string) ?? null,
    promotion_code: (raw.promotion_code as string) ?? null,
    payment_status: (raw.payment_status as string) ?? "unpaid",
    created_at: (raw.created_at as string) ?? new Date().toISOString(),
    branch_id: (raw.branch_id as string | null) ?? null,
    job_id: (raw.job_id as string | null) ?? null,
    due_date: (raw.due_date as string | null) ?? null,
    customer_id: (raw.customer_id as string | null) ?? null,
  };
}

async function fetchCustomerLineLink(
  customerId: string | null
): Promise<LinkedCustomer | null> {
  if (!customerId) return null;
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const res = await admin
    .from("customer_line_links")
    .select(
      "customer_id, line_user_id, notify_order_received, notify_order_ready, notify_pickup_reminder, notify_receipt, unsubscribed_at"
    )
    .eq("customer_id", customerId)
    .maybeSingle();
  if (res.error || !res.data) return null;
  const row = res.data as {
    customer_id: string | null;
    line_user_id: string;
    notify_order_received: boolean | null;
    notify_order_ready: boolean | null;
    notify_pickup_reminder: boolean | null;
    notify_receipt: boolean | null;
    unsubscribed_at: string | null;
  };
  return {
    customer_id: row.customer_id,
    line_user_id: row.line_user_id,
    prefs: {
      order_received: row.notify_order_received ?? true,
      order_ready: row.notify_order_ready ?? true,
      pickup_reminder: row.notify_pickup_reminder ?? true,
      receipt: row.notify_receipt ?? true,
    },
    unsubscribed: row.unsubscribed_at !== null,
  };
}

async function resolveBranchUuid(
  branchCode: string | null
): Promise<string | null> {
  if (!branchCode) return null;
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const res = await admin
    .from("branches")
    .select("id")
    .eq("code", branchCode)
    .maybeSingle();
  if (res.error || !res.data) return null;
  return (res.data as { id?: string }).id ?? null;
}

type LogInput = {
  kind: LineMessageKind;
  order: OrderRow;
  link: LinkedCustomer | null;
  branchCode: string | null;
  channel: LineChannelConfig | null;
  messageText: string | null;
  status: "sent" | "failed" | "skipped";
  errorReason: string | null;
  sentAt: string | null;
  actorId: string | null;
};

async function writeMessageLog(input: LogInput): Promise<string | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const res = await admin
    .from("line_message_log")
    .insert({
      customer_id: input.order.customer_id ?? null,
      order_id: input.order.id,
      branch_id: input.branchCode,
      line_user_id: input.link?.line_user_id ?? null,
      kind: input.kind,
      message_text: input.messageText,
      payload: {
        channelOrigin: input.channel?.origin ?? null,
        oaBasicId: input.channel?.oaBasicId ?? null,
      },
      status: input.status,
      error_reason: input.errorReason,
      sent_at: input.sentAt,
      created_by: input.actorId,
    })
    .select("id")
    .maybeSingle();
  if (res.error || !res.data) {
    console.warn(
      "[lineDelivery] message log insert failed",
      res.error?.message ?? "no data"
    );
    return null;
  }
  return (res.data as { id?: string }).id ?? null;
}

function skip(
  kind: LineMessageKind,
  _branchCode: string | null,
  reason: string
): DeliveryResult {
  return { ok: false, status: "skipped", kind, reason, logId: null };
}

async function logAndSkip(
  kind: LineMessageKind,
  order: OrderRow,
  link: LinkedCustomer | null,
  reason: string,
  ctx: DeliveryContext
): Promise<DeliveryResult> {
  const logId = await writeMessageLog({
    kind,
    order,
    link,
    branchCode: order.branch_id,
    channel: null,
    messageText: null,
    status: "skipped",
    errorReason: reason,
    sentAt: null,
    actorId: ctx.actorId ?? null,
  });
  return { ok: false, status: "skipped", kind, reason, logId };
}
