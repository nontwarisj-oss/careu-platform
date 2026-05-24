// Phase C / L8 — LINE Flex "quote summary" builder. Pure.
//
// Architecture doc LINE-OA-Intake-Architecture.md §10.6: after the
// Owner/Admin approves a price, the shop sends the customer a Flex
// "ใบเสนอราคา" (quote summary) — service, branch, price, validity.
//
// F1 / F3 guard: the AI never prices. The `price` here is a number the
// Owner/Admin typed and reviewed on /admin/intake-drafts; this module only
// renders it. Building the Flex does NOT send it — the send route does,
// and only on an explicit admin button press.
//
// Pure — no DB, no fetch, no React. Server- and client-safe. The returned
// object is structurally a LINE "flex" message (matches the `flex` arm of
// lib/lineMessaging.ts::LineMessage), so the send route can hand it
// straight to pushMessages().

// ---------- Types ----------------------------------------------------------

export type QuoteFlexInput = {
  /** Shop name shown in the header, e.g. "Care U". */
  shopName: string;
  /** What is being quoted, e.g. "ตัดขากางเกงยีนส์ (เก็บชายเดิม)". */
  serviceText: string;
  /** Approved price in baht. Must be a finite number >= 0. */
  price: number;
  /** Optional branch line. */
  branchText?: string | null;
  /** Optional job / draft code line. */
  jobCode?: string | null;
  /** Optional validity note, e.g. "ราคานี้ยืนยัน 7 วัน". */
  validityText?: string | null;
  /** Who approved — defaults to "เจ้าของร้าน". */
  approvedByText?: string | null;
  /** Optional shop phone — when present, adds a "โทรหาร้าน" button. */
  shopPhone?: string | null;
};

/** Structurally a LINE flex message — assignable to lineMessaging LineMessage. */
export type QuoteFlexMessage = {
  type: "flex";
  altText: string;
  contents: Record<string, unknown>;
};

// ---------- Validation -----------------------------------------------------

export function validateQuoteFlexInput(
  input: QuoteFlexInput
): { ok: true } | { ok: false; reason: string } {
  if (!input.shopName || input.shopName.trim().length === 0) {
    return { ok: false, reason: "ไม่มีชื่อร้าน" };
  }
  if (!input.serviceText || input.serviceText.trim().length === 0) {
    return { ok: false, reason: "ยังไม่ได้ระบุบริการที่เสนอราคา" };
  }
  if (
    typeof input.price !== "number" ||
    !Number.isFinite(input.price) ||
    input.price < 0
  ) {
    return { ok: false, reason: "ราคาไม่ถูกต้อง — ต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป" };
  }
  return { ok: true };
}

// ---------- Builder --------------------------------------------------------

/** Format a baht amount with thousands separators, no decimals. */
function formatBaht(price: number): string {
  return Math.round(price).toLocaleString("en-US") + " บาท";
}

/** Keep only digits — a `tel:` URI must not carry spaces or dashes. */
function telDigits(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

/** One "label : value" line in the body. */
function infoRow(label: string, value: string): Record<string, unknown> {
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      { type: "text", text: label, size: "sm", color: "#8A8A8A", flex: 3 },
      {
        type: "text",
        text: value,
        size: "sm",
        color: "#333333",
        flex: 7,
        wrap: true,
      },
    ],
  };
}

/**
 * Build the quote-summary Flex message (design §10.6).
 *
 * Throws nothing — call validateQuoteFlexInput first if the input is
 * user-supplied. Defaults are applied for missing optional fields.
 */
export function buildQuoteFlex(input: QuoteFlexInput): QuoteFlexMessage {
  const shopName = input.shopName.trim();
  const serviceText = input.serviceText.trim();
  const priceText = formatBaht(input.price);
  const approvedBy =
    input.approvedByText && input.approvedByText.trim().length > 0
      ? input.approvedByText.trim()
      : "เจ้าของร้าน";

  // ---- body rows ----
  const bodyContents: Record<string, unknown>[] = [];
  bodyContents.push(infoRow("บริการ", serviceText));
  if (input.branchText && input.branchText.trim().length > 0) {
    bodyContents.push(infoRow("สาขา", input.branchText.trim()));
  }
  if (input.jobCode && input.jobCode.trim().length > 0) {
    bodyContents.push(infoRow("รหัสงาน", input.jobCode.trim()));
  }
  bodyContents.push({ type: "separator", margin: "md" });
  // Price — emphasised.
  bodyContents.push({
    type: "box",
    layout: "baseline",
    spacing: "sm",
    margin: "md",
    contents: [
      { type: "text", text: "ราคา", size: "sm", color: "#8A8A8A", flex: 3 },
      {
        type: "text",
        text: priceText,
        size: "xl",
        weight: "bold",
        color: "#1B5E20",
        flex: 7,
        wrap: true,
      },
    ],
  });
  bodyContents.push(infoRow("ยืนยันโดย", approvedBy));
  if (input.validityText && input.validityText.trim().length > 0) {
    bodyContents.push({
      type: "text",
      text: input.validityText.trim(),
      size: "xs",
      color: "#8A8A8A",
      wrap: true,
      margin: "md",
    });
  }
  bodyContents.push({
    type: "text",
    text: "ราคานี้ยืนยันแล้ว — รบกวนลูกค้ายืนยันรับงานในแชตนี้ได้เลยค่ะ 🙏",
    size: "xs",
    color: "#8A8A8A",
    wrap: true,
    margin: "sm",
  });

  // ---- footer buttons ----
  const footerContents: Record<string, unknown>[] = [
    {
      type: "button",
      style: "primary",
      color: "#1B5E20",
      height: "sm",
      action: {
        type: "message",
        label: "ยืนยันรับงาน",
        text: "ยืนยันรับงานค่ะ 🙏",
      },
    },
  ];
  if (input.shopPhone && telDigits(input.shopPhone).length > 0) {
    footerContents.push({
      type: "button",
      style: "secondary",
      height: "sm",
      action: {
        type: "uri",
        label: "โทรหาร้าน",
        uri: "tel:" + telDigits(input.shopPhone),
      },
    });
  }

  const contents: Record<string, unknown> = {
    type: "bubble",
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: "💰 ใบเสนอราคา — " + shopName,
          weight: "bold",
          size: "lg",
          color: "#1B5E20",
          wrap: true,
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: bodyContents,
    },
    footer: {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: footerContents,
    },
  };

  // altText shows in the chat list / notification (LINE caps it at 400).
  const altText = (
    "ใบเสนอราคา " + shopName + " — " + serviceText + " : " + priceText
  ).slice(0, 400);

  return { type: "flex", altText, contents };
}
