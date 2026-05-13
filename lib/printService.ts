// Print + export orchestration. The receipt template components only
// render; this module owns side effects (window.print, html-to-image,
// future PDF / LINE export).
//
// Browser-only — the file is safe to import from "use client" components
// but every function guards on `typeof window` so SSR doesn't crash.
//
// Future-proofing:
//   • generateReceiptPdf is stubbed today; the receipt template can be
//     rendered to a hidden canvas + handed to a PDF library when one is
//     added.
//   • sendReceiptViaLine is stubbed; the lib/lineOA.ts stub will plug in
//     once the channel access token is provisioned.

import type { ReceiptData } from "@/lib/receiptData";

export type PrintMode = "a4" | "thermal" | "mobile";

export const PRINT_MODE_LABELS: Record<PrintMode, { th: string; en: string }> = {
  a4: { th: "A4 (เอกสารเต็ม)", en: "A4 (full page)" },
  thermal: { th: "ใบเสร็จร้านสะดวก (80mm)", en: "Thermal (80mm)" },
  mobile: { th: "มือถือ (ดูในแอป)", en: "Mobile preview" },
};

const PRINT_BODY_CLASS = "printing-receipt";
const PRINT_THERMAL_CLASS = "printing-thermal";
const PRINT_TARGET_CLASS = "print-this";
const THERMAL_PAGE_STYLE_ID = "careu-thermal-page-style";

// CSS spec forbids `@page` from being nested inside a normal selector, so
// we inject the rule as a top-level <style> right before printing and tear
// it down immediately after. Margin = 4mm matches an ESC/POS 80mm spec.
function injectThermalPageRule() {
  if (typeof document === "undefined") return;
  if (document.getElementById(THERMAL_PAGE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = THERMAL_PAGE_STYLE_ID;
  style.textContent = `@media print { @page { size: 80mm auto; margin: 4mm; } }`;
  document.head.appendChild(style);
}

function removeThermalPageRule() {
  if (typeof document === "undefined") return;
  document.getElementById(THERMAL_PAGE_STYLE_ID)?.remove();
}

/**
 * Trigger a browser print of a single receipt card. The element must have
 * the data-receipt-id attribute set so we can deduplicate when multiple
 * receipt nodes exist on the page (mode toggles render hidden alternates).
 *
 * `mode` selects the print page-size + body class. For thermal mode we
 * inject an `@page { size: 80mm auto }` style tag at runtime since the
 * CSS spec doesn't allow @page to be nested under a body-class selector.
 */
export function printReceipt(opts: {
  mode: PrintMode;
  /** DOM id of the receipt root. Default: "careu-receipt-card". */
  rootId?: string;
}): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  const rootId = opts.rootId ?? "careu-receipt-card";
  const card = document.getElementById(rootId);
  if (!card) {
    console.warn(`[printService] receipt root #${rootId} not found`);
    return false;
  }
  const body = document.body;
  card.classList.add(PRINT_TARGET_CLASS);
  body.classList.add(PRINT_BODY_CLASS);
  if (opts.mode === "thermal") {
    body.classList.add(PRINT_THERMAL_CLASS);
    injectThermalPageRule();
  }
  try {
    window.print();
  } finally {
    card.classList.remove(PRINT_TARGET_CLASS);
    body.classList.remove(PRINT_BODY_CLASS);
    body.classList.remove(PRINT_THERMAL_CLASS);
    removeThermalPageRule();
  }
  return true;
}

export type SaveImageResult =
  | { ok: true; fileName: string }
  | { ok: false; reason: string };

/**
 * Snapshot the receipt card as a JPEG and trigger a download. Used today
 * for customer LINE chats (paste the image). Future: replace with a PDF
 * generator that runs server-side for higher fidelity.
 */
export async function saveReceiptAsImage(opts: {
  rootId?: string;
  receipt: ReceiptData;
  pixelRatio?: number;
}): Promise<SaveImageResult> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { ok: false, reason: "Not running in a browser" };
  }
  const rootId = opts.rootId ?? "careu-receipt-card";
  const card = document.getElementById(rootId);
  if (!card) return { ok: false, reason: `Receipt #${rootId} not found` };

  try {
    const { toJpeg } = await import("html-to-image");
    const dataUrl = await toJpeg(card as HTMLElement, {
      pixelRatio: opts.pixelRatio ?? 2,
      quality: 0.95,
      backgroundColor: "#ffffff",
      cacheBust: true,
    });
    const fileName = `careu-${opts.receipt.meta.refId}.jpg`;
    const link = document.createElement("a");
    link.download = fileName;
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return { ok: true, fileName };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "unknown image error",
    };
  }
}

// ---------- Future delivery channels (stubs) -----------------------------

/**
 * Stub for server-side PDF generation. Future implementation: render the
 * receipt template via a headless browser or a PDF library (jsPDF /
 * pdf-lib) and return the binary. Keep the signature stable so the
 * `/orders/[id]/document` action bar can wire it up without changes.
 */
export async function generateReceiptPdf(
  _receipt: ReceiptData
): Promise<{ ok: false; reason: string }> {
  return {
    ok: false,
    reason: "PDF export not yet implemented — next phase.",
  };
}

/**
 * Stub for LINE OA delivery. The plumbing already exists in lib/lineOA.ts
 * for plain-text messages; this stub is for image / Flex Message payload
 * built from the receipt structure. Returns ok:false until the channel
 * token is configured.
 */
export async function sendReceiptViaLine(
  _receipt: ReceiptData
): Promise<{ ok: false; reason: string }> {
  return {
    ok: false,
    reason:
      "LINE OA image delivery not yet implemented — uses the text helper " +
      "in lib/lineOA.ts for now.",
  };
}
