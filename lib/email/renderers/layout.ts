// Email layout shell — wraps blocks in a responsive 600px-max table
// with email-safe inline styles.
//
// Used by:
//   • Phase 19 retention triggers when channel = email.
//   • Future broadcast send pipeline for HTML campaigns.
//   • The template editor's HTML preview (server-rendered).
//
// Server-only.

import {
  type EmailBlock,
  type EmailBrand,
  renderBlock,
  blocksToPlainText,
} from "./blocks";

export type RenderedEmail = {
  html: string;
  text: string;
};

export type LayoutInput = {
  brand: EmailBrand;
  /** Optional pre-header — the snippet preview that shows in inboxes
   *  next to the subject line. Hidden in the rendered email body. */
  preheader?: string;
  blocks: EmailBlock[];
  /** Optional unsubscribe URL — rendered as a small footer link.
   *  Required when the email is promotional (LIST-UNSUBSCRIBE header
   *  is the operator's responsibility on the provider side). */
  unsubscribeUrl?: string;
};

export function renderEmailLayout(input: LayoutInput): RenderedEmail {
  const inner = input.blocks
    .map((b) => renderBlock(b, input.brand))
    .join("\n");

  // The pre-header is a hidden span that email clients use as preview
  // text in inbox lists. Make it just-visible enough by including
  // non-breaking spaces.
  const preheader = input.preheader
    ? `<div style="display: none; max-height: 0; overflow: hidden;">${escape(input.preheader)}</div>`
    : "";

  const unsubFooter = input.unsubscribeUrl
    ? `<tr><td style="padding: 8px 24px 18px; text-align: center; font-size: 11px; color: #9ca3af;">
        ไม่ต้องการรับอีเมลแบบนี้?
        <a href="${escape(input.unsubscribeUrl)}" style="color: #6b7280;">ยกเลิกการรับ</a>
      </td></tr>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${escape(input.brand.receiptName)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f9fafb;">
  ${preheader}
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #f9fafb;">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 12px; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
          ${inner}
          ${unsubFooter}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  const text = blocksToPlainText(input.blocks) + (input.unsubscribeUrl ? `\n\n— ไม่ต้องการรับอีเมลนี้: ${input.unsubscribeUrl}` : "");
  return { html, text };
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
