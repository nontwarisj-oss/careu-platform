// Email block primitives — pure functions that return HTML strings.
//
// Phase 19 ships a hand-written renderer (no MJML, no template
// engine dependency). Each block is a small composable function;
// the layout composes them with a responsive shell.
//
// Style rules:
//   • Inline CSS only — Gmail and most clients strip <style> tags.
//   • Tables for layout — flexbox is unsupported in many email clients.
//   • Dark-mode tolerant via `meta name="color-scheme"` + neutral
//     backgrounds.
//   • Max width 600px — fits a typical mobile portrait viewport.
//
// Server-only — strings, no DOM.

export type EmailBrand = {
  receiptName: string;
  shortLabel: string;
  address: string;
  /** Hex colour for buttons + headlines. Defaults to CareU green. */
  accent?: string;
};

const DEFAULT_ACCENT = "#15803d";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- Hero -------------------------------------------------------

export type HeroBlock = {
  kind: "hero";
  title: string;
  subtitle?: string;
};

export function renderHero(block: HeroBlock, brand: EmailBrand): string {
  const accent = brand.accent ?? DEFAULT_ACCENT;
  return `
<tr>
  <td style="padding: 32px 24px 16px; text-align: center;">
    <h1 style="margin: 0; font-size: 26px; font-weight: 800; color: ${accent}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
      ${escapeHtml(block.title)}
    </h1>
    ${
      block.subtitle
        ? `<p style="margin: 8px 0 0; font-size: 14px; color: #4b5563; line-height: 1.6;">${escapeHtml(block.subtitle)}</p>`
        : ""
    }
  </td>
</tr>`;
}

// ---------- Body / paragraph ------------------------------------------

export type BodyBlock = {
  kind: "body";
  /** Plain text or pre-escaped HTML. By default treated as plain text. */
  text: string;
  /** When true, `text` is HTML and not escaped. Use sparingly — only
   *  for operator-controlled content from the template editor. */
  raw?: boolean;
};

export function renderBody(block: BodyBlock): string {
  const inner = block.raw ? block.text : escapeHtml(block.text).replace(/\n/g, "<br />");
  return `
<tr>
  <td style="padding: 8px 24px; font-size: 15px; line-height: 1.7; color: #1f2937;">
    ${inner}
  </td>
</tr>`;
}

// ---------- CTA --------------------------------------------------------

export type CTABlock = {
  kind: "cta";
  label: string;
  url: string;
};

export function renderCTA(block: CTABlock, brand: EmailBrand): string {
  const accent = brand.accent ?? DEFAULT_ACCENT;
  return `
<tr>
  <td style="padding: 16px 24px 24px; text-align: center;">
    <a href="${escapeHtml(block.url)}" style="display: inline-block; background-color: ${accent}; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 700; font-size: 15px;">
      ${escapeHtml(block.label)}
    </a>
  </td>
</tr>`;
}

// ---------- Service summary -------------------------------------------

export type ServiceSummaryBlock = {
  kind: "service_summary";
  service: string;
  jobId?: string;
  price?: number;
  pickupDate?: string;
};

export function renderServiceSummary(block: ServiceSummaryBlock): string {
  const rows: Array<[string, string]> = [];
  if (block.jobId) rows.push(["เลขที่งาน", block.jobId]);
  rows.push(["บริการ", block.service]);
  if (typeof block.price === "number") {
    rows.push(["ยอดประเมิน", `฿${Math.round(block.price).toLocaleString()}`]);
  }
  if (block.pickupDate) rows.push(["นัดรับ", block.pickupDate]);

  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">${escapeHtml(label)}</td><td style="padding: 4px 0; color: #111827; font-size: 13px; text-align: right; font-weight: 600;">${escapeHtml(value)}</td></tr>`
    )
    .join("");
  return `
<tr>
  <td style="padding: 8px 24px;">
    <table cellpadding="0" cellspacing="0" border="0" style="width: 100%; background: #f3f4f6; border-radius: 8px; padding: 12px;">
      ${rowsHtml}
    </table>
  </td>
</tr>`;
}

// ---------- Pickup reminder -------------------------------------------

export type PickupReminderBlock = {
  kind: "pickup_reminder";
  jobId: string;
  branchAddress: string;
  hours?: string;
};

export function renderPickupReminder(block: PickupReminderBlock): string {
  return `
<tr>
  <td style="padding: 8px 24px;">
    <table cellpadding="0" cellspacing="0" border="0" style="width: 100%; background: #fffbeb; border-left: 4px solid #d97706; border-radius: 6px; padding: 12px;">
      <tr>
        <td style="font-size: 13px; line-height: 1.6; color: #78350f;">
          งาน <strong>${escapeHtml(block.jobId)}</strong> ยังรอรับที่<br />
          ${escapeHtml(block.branchAddress)}<br />
          ${block.hours ? `เวลาทำการ: ${escapeHtml(block.hours)}` : ""}
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

// ---------- Coupon placeholder ----------------------------------------

export type CouponBlock = {
  kind: "coupon";
  /** Placeholder code — Phase 19 does NOT generate / validate coupons. */
  code: string;
  description: string;
  expiresAt?: string;
};

export function renderCoupon(block: CouponBlock): string {
  return `
<tr>
  <td style="padding: 12px 24px;">
    <table cellpadding="0" cellspacing="0" border="0" style="width: 100%; border: 2px dashed #10b981; border-radius: 8px; padding: 14px; text-align: center;">
      <tr>
        <td style="font-size: 12px; color: #047857; text-transform: uppercase; letter-spacing: 2px;">โค้ดส่วนลด</td>
      </tr>
      <tr>
        <td style="font-size: 22px; font-weight: 800; color: #064e3b; font-family: 'Courier New', monospace; padding: 6px 0;">${escapeHtml(block.code)}</td>
      </tr>
      <tr>
        <td style="font-size: 13px; color: #1f2937;">${escapeHtml(block.description)}</td>
      </tr>
      ${
        block.expiresAt
          ? `<tr><td style="font-size: 11px; color: #6b7280; padding-top: 4px;">ใช้ก่อน ${escapeHtml(block.expiresAt)}</td></tr>`
          : ""
      }
    </table>
  </td>
</tr>`;
}

// ---------- Order timeline --------------------------------------------

export type OrderTimelineBlock = {
  kind: "order_timeline";
  steps: Array<{ label: string; status: "done" | "current" | "pending" }>;
};

export function renderOrderTimeline(block: OrderTimelineBlock, brand: EmailBrand): string {
  const accent = brand.accent ?? DEFAULT_ACCENT;
  const stepsHtml = block.steps
    .map((s) => {
      const colour =
        s.status === "done"
          ? accent
          : s.status === "current"
            ? "#f59e0b"
            : "#d1d5db";
      const weight = s.status === "current" ? "700" : "500";
      return `<tr>
        <td style="padding: 4px 0; width: 18px; vertical-align: top;">
          <div style="width: 10px; height: 10px; border-radius: 5px; background: ${colour}; margin-top: 4px;"></div>
        </td>
        <td style="padding: 4px 0 4px 8px; font-size: 13px; color: #1f2937; font-weight: ${weight};">${escapeHtml(s.label)}</td>
      </tr>`;
    })
    .join("");
  return `
<tr>
  <td style="padding: 8px 24px;">
    <table cellpadding="0" cellspacing="0" border="0" style="width: 100%;">
      ${stepsHtml}
    </table>
  </td>
</tr>`;
}

// ---------- Branch contact info ---------------------------------------

export type BranchContactBlock = {
  kind: "branch_contact";
};

export function renderBranchContact(_block: BranchContactBlock, brand: EmailBrand): string {
  return `
<tr>
  <td style="padding: 12px 24px 24px; font-size: 12px; color: #6b7280; text-align: center;">
    ${escapeHtml(brand.receiptName)} · ${escapeHtml(brand.address)}
  </td>
</tr>`;
}

// ---------- Block discriminated union ---------------------------------

export type EmailBlock =
  | HeroBlock
  | BodyBlock
  | CTABlock
  | ServiceSummaryBlock
  | PickupReminderBlock
  | CouponBlock
  | OrderTimelineBlock
  | BranchContactBlock;

export function renderBlock(block: EmailBlock, brand: EmailBrand): string {
  switch (block.kind) {
    case "hero":
      return renderHero(block, brand);
    case "body":
      return renderBody(block);
    case "cta":
      return renderCTA(block, brand);
    case "service_summary":
      return renderServiceSummary(block);
    case "pickup_reminder":
      return renderPickupReminder(block);
    case "coupon":
      return renderCoupon(block);
    case "order_timeline":
      return renderOrderTimeline(block, brand);
    case "branch_contact":
      return renderBranchContact(block, brand);
  }
}

// ---------- Plain-text fallback ---------------------------------------
//
// Strip blocks into a sensible plain-text representation. Used by
// the dispatch worker when sending SMS / LINE renders from the same
// block list, or as the multipart/alternative text/plain part of an
// email.

export function blocksToPlainText(blocks: EmailBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "hero":
        parts.push(block.title);
        if (block.subtitle) parts.push(block.subtitle);
        break;
      case "body":
        parts.push(block.text);
        break;
      case "cta":
        parts.push(`${block.label}: ${block.url}`);
        break;
      case "service_summary":
        if (block.jobId) parts.push(`เลขที่งาน ${block.jobId}`);
        parts.push(`บริการ: ${block.service}`);
        if (typeof block.price === "number")
          parts.push(`ยอด ฿${Math.round(block.price).toLocaleString()}`);
        if (block.pickupDate) parts.push(`นัดรับ: ${block.pickupDate}`);
        break;
      case "pickup_reminder":
        parts.push(
          `งาน ${block.jobId} รอที่ ${block.branchAddress}${
            block.hours ? `, ${block.hours}` : ""
          }`
        );
        break;
      case "coupon":
        parts.push(`โค้ด ${block.code} — ${block.description}`);
        if (block.expiresAt) parts.push(`ใช้ก่อน ${block.expiresAt}`);
        break;
      case "order_timeline":
        parts.push(
          block.steps
            .map(
              (s) =>
                `${s.status === "done" ? "✓" : s.status === "current" ? "•" : "○"} ${s.label}`
            )
            .join("\n")
        );
        break;
      case "branch_contact":
        // Plain text version is rendered by the caller via brand.
        break;
    }
  }
  return parts.filter((p) => p.trim().length > 0).join("\n\n");
}
