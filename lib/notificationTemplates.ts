// Notification template engine.
//
// Centralises every transactional / lifecycle message body so the
// lifecycle notifier (lib/lifecycleNotifier.ts) doesn't reinvent
// strings at each call site. Sibling to lib/lineMessageBuilders.ts,
// which exists for the older LINE-only orchestrator — over time the
// orchestrator will migrate to this engine, but for this phase we
// run them in parallel so the OPS UI does not change.
//
// Design:
//   • One pure function per template kind: takes a TemplateContext,
//     returns { sms, line } bodies. Both channels share the same
//     underlying facts; the SMS body is tighter (160-char target) and
//     the LINE body has more breathing room.
//   • Branch branding via BranchTemplateBrand (receiptName, shortLabel,
//     address). Sourced from brandConfig at the notifier layer; this
//     engine stays a pure renderer.
//   • Customer tier personalization via the optional `tier` field.
//     VIP / gold customers get a slightly warmer greeting. Default
//     tier renders the standard greeting.
//   • Variable injection happens through the typed input — NO string
//     templating with {{ }}. Easier to TypeScript-check at every call
//     site and impossible to introduce a runtime "missing variable"
//     bug.
//
// Server-OR-client safe. Pure functions only — no DB, no fetch.

export type NotificationKind =
  | "order_created"
  | "repair_started"
  | "ready_for_pickup"
  | "order_completed"
  | "overdue_pickup"
  | "payment_received"
  | "otp";

export type BranchTemplateBrand = {
  receiptName: string;
  shortLabel: string;
  address: string;
};

export type CustomerTier = "bronze" | "silver" | "gold" | "platinum" | "vip" | null;

export type RenderedTemplate = {
  /** SMS body — kept short. Aim ≤ 160 chars; longer than that splits
   *  into multiple SMS segments and costs more. */
  sms: string;
  /** LINE body — has more room, can include line breaks, emoji-free. */
  line: string;
};

export type TemplateContext = {
  kind: NotificationKind;
  branch: BranchTemplateBrand;
  /** Customer display name. Falls back to a polite "ลูกค้า" greeting
   *  when missing. */
  customerName?: string | null;
  /** Customer tier — VIP / gold etc. Optional warm greeting. */
  tier?: CustomerTier;
  /** Order short reference — Job ID or refId. Optional for kinds
   *  that aren't order-specific (e.g. otp). */
  ref?: string | null;
  /** Service label. Optional. */
  service?: string | null;
  /** Outstanding balance in Baht (integer). 0 means fully paid. */
  amountOwed?: number;
  /** Total amount on the receipt. Used for payment_received. */
  amountPaid?: number;
  /** Pickup-by date label (e.g. "14 พ.ค." / "Sat 18:00"). */
  dueLabel?: string | null;
  /** OTP code — only for the 'otp' kind. */
  otpCode?: string;
  /** OTP TTL in minutes. */
  otpTtlMinutes?: number;
};

// ---------- Helpers -------------------------------------------------------

function honorificFor(name: string | null | undefined, tier: CustomerTier): string {
  const cleaned = (name ?? "").trim();
  if (!cleaned) return "ลูกค้า";
  // VIP / Platinum / Gold get a courteous "คุณ" prefix even if the
  // customer is stored without one. Bronze / Silver / null keep the
  // exact name (the customer may already have a preferred form).
  if (tier && (tier === "vip" || tier === "platinum" || tier === "gold")) {
    if (cleaned.startsWith("คุณ")) return cleaned;
    return `คุณ${cleaned}`;
  }
  return cleaned;
}

function fmtBaht(amount: number | undefined): string {
  if (!amount || amount <= 0) return "฿0";
  return `฿${Math.round(amount).toLocaleString()}`;
}

function refLine(ref: string | null | undefined): string {
  if (!ref || !ref.trim()) return "";
  return `เลขที่: ${ref}`;
}

function joinLine(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p && p.trim().length > 0).join("\n");
}

// ---------- Per-kind renderers -------------------------------------------

function renderOrderCreated(ctx: TemplateContext): RenderedTemplate {
  const greeting = honorificFor(ctx.customerName, ctx.tier ?? null);
  const service = ctx.service ? `งาน: ${ctx.service}` : "";
  return {
    sms: [
      `${ctx.branch.receiptName} รับงาน ${ctx.ref ?? "-"}`,
      `เราจะแจ้งเมื่อพร้อมรับ`,
    ].join(" "),
    line: joinLine([
      `${ctx.branch.receiptName} ขอบคุณที่ใช้บริการ ${greeting}`,
      `รับงานเข้าระบบเรียบร้อย`,
      "",
      refLine(ctx.ref),
      service,
      ctx.amountOwed !== undefined ? `ยอดประเมิน: ${fmtBaht(ctx.amountOwed)}` : "",
      ctx.dueLabel ? `นัดรับ: ${ctx.dueLabel}` : "",
      "",
      `เราจะแจ้งอีกครั้งเมื่องานเสร็จ`,
      `${ctx.branch.shortLabel} • ${ctx.branch.address}`,
    ]),
  };
}

function renderRepairStarted(ctx: TemplateContext): RenderedTemplate {
  const service = ctx.service ? `งาน: ${ctx.service}` : "";
  return {
    sms: `${ctx.branch.receiptName} เริ่มซ่อมงาน ${ctx.ref ?? "-"} แล้ว`,
    line: joinLine([
      `${ctx.branch.receiptName}`,
      `ช่างเริ่มดำเนินการแล้ว`,
      "",
      refLine(ctx.ref),
      service,
      ctx.dueLabel ? `กำหนดเสร็จ: ${ctx.dueLabel}` : "",
      "",
      `เราจะแจ้งเมื่อพร้อมรับ`,
      `${ctx.branch.shortLabel}`,
    ]),
  };
}

function renderReadyForPickup(ctx: TemplateContext): RenderedTemplate {
  const greeting = honorificFor(ctx.customerName, ctx.tier ?? null);
  const owedLine =
    ctx.amountOwed && ctx.amountOwed > 0
      ? `ยอดที่ต้องชำระ: ${fmtBaht(ctx.amountOwed)}`
      : `ชำระเรียบร้อย`;
  return {
    sms: [
      `${ctx.branch.receiptName} งาน ${ctx.ref ?? "-"} พร้อมรับแล้ว`,
      ctx.amountOwed && ctx.amountOwed > 0
        ? `ยอด ${fmtBaht(ctx.amountOwed)}`
        : "ชำระเรียบร้อย",
    ].join(" "),
    line: joinLine([
      `${ctx.branch.receiptName}`,
      `${greeting} — งานของคุณพร้อมรับแล้ว`,
      "",
      refLine(ctx.ref),
      ctx.service ? `งาน: ${ctx.service}` : "",
      owedLine,
      "",
      `เวลาทำการ จันทร์–เสาร์ 09:00–18:00`,
      `${ctx.branch.shortLabel} • ${ctx.branch.address}`,
    ]),
  };
}

function renderOrderCompleted(ctx: TemplateContext): RenderedTemplate {
  const greeting = honorificFor(ctx.customerName, ctx.tier ?? null);
  return {
    sms: `${ctx.branch.receiptName} ขอบคุณ ${ctx.ref ?? ""} เสร็จสิ้น`.trim(),
    line: joinLine([
      `${ctx.branch.receiptName}`,
      `${greeting} ขอบคุณที่ใช้บริการ`,
      "",
      refLine(ctx.ref),
      ctx.service ? `งาน: ${ctx.service}` : "",
      `งานปิดเรียบร้อย — แล้วพบกันใหม่`,
      `${ctx.branch.shortLabel}`,
    ]),
  };
}

function renderOverduePickup(ctx: TemplateContext): RenderedTemplate {
  return {
    sms: `${ctx.branch.receiptName} แจ้งเตือน งาน ${ctx.ref ?? "-"} ยังรอรับ`,
    line: joinLine([
      `${ctx.branch.receiptName}`,
      `แจ้งเตือน — งานยังรอลูกค้ามารับ`,
      "",
      refLine(ctx.ref),
      ctx.service ? `งาน: ${ctx.service}` : "",
      ctx.dueLabel ? `กำหนดรับ: ${ctx.dueLabel}` : "",
      ctx.amountOwed && ctx.amountOwed > 0
        ? `ยอดคงเหลือ: ${fmtBaht(ctx.amountOwed)}`
        : "",
      "",
      `กรุณาแวะรับเมื่อสะดวก ขอบคุณค่ะ`,
      `${ctx.branch.shortLabel}`,
    ]),
  };
}

function renderPaymentReceived(ctx: TemplateContext): RenderedTemplate {
  return {
    sms: [
      `${ctx.branch.receiptName} รับชำระ`,
      ctx.amountPaid ? fmtBaht(ctx.amountPaid) : "",
      ctx.ref ? `งาน ${ctx.ref}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    line: joinLine([
      `${ctx.branch.receiptName}`,
      `รับชำระเรียบร้อย`,
      "",
      refLine(ctx.ref),
      ctx.amountPaid ? `จำนวน: ${fmtBaht(ctx.amountPaid)}` : "",
      ctx.service ? `งาน: ${ctx.service}` : "",
      "",
      `ขอบคุณที่ใช้บริการ`,
      `${ctx.branch.shortLabel}`,
    ]),
  };
}

function renderOtp(ctx: TemplateContext): RenderedTemplate {
  const minutes = ctx.otpTtlMinutes ?? 5;
  return {
    sms: `${ctx.branch.receiptName} รหัสยืนยัน: ${ctx.otpCode} (อายุ ${minutes} นาที)`,
    line: joinLine([
      `${ctx.branch.receiptName}`,
      `รหัสยืนยัน: ${ctx.otpCode}`,
      `(อายุ ${minutes} นาที — อย่าแชร์ให้ผู้อื่น)`,
    ]),
  };
}

// ---------- Public entry --------------------------------------------------

const RENDERERS: Record<NotificationKind, (ctx: TemplateContext) => RenderedTemplate> = {
  order_created: renderOrderCreated,
  repair_started: renderRepairStarted,
  ready_for_pickup: renderReadyForPickup,
  order_completed: renderOrderCompleted,
  overdue_pickup: renderOverduePickup,
  payment_received: renderPaymentReceived,
  otp: renderOtp,
};

export function renderNotification(ctx: TemplateContext): RenderedTemplate {
  const r = RENDERERS[ctx.kind];
  if (!r) {
    // Fallback — should be impossible thanks to the union type. Render
    // a minimal generic body rather than throwing.
    return {
      sms: `${ctx.branch.receiptName}`,
      line: `${ctx.branch.receiptName}`,
    };
  }
  return r(ctx);
}

/** Map a NotificationKind to the per-channel preference field that
 *  gates it. Used by the lifecycle notifier to skip enqueue when the
 *  customer has opted out of that kind. */
export function preferenceFieldFor(
  kind: NotificationKind
):
  | "order_status_alerts"
  | "pickup_reminders"
  | "payment_alerts"
  | "promotional"
  | "transactional" {
  switch (kind) {
    case "order_created":
    case "repair_started":
    case "order_completed":
      return "order_status_alerts";
    case "ready_for_pickup":
    case "overdue_pickup":
      return "pickup_reminders";
    case "payment_received":
      return "payment_alerts";
    case "otp":
      // OTP is identity-critical — never gated by preferences.
      return "transactional";
  }
}

export const NOTIFICATION_KINDS: NotificationKind[] = [
  "order_created",
  "repair_started",
  "ready_for_pickup",
  "order_completed",
  "overdue_pickup",
  "payment_received",
  "otp",
];
