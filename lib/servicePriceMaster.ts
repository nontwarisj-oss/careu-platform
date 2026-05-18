// Pricing Master (Phase 2) — types, data access, and the quote engine.
//
// public.service_price_master is the system source of truth for service
// pricing. The Google Sheet "Service_Prices" tab is only the easy editing
// surface; an owner-only route syncs it into this table.
//
// Design rule (so future AI intake — image / voice / video — can reuse it):
// the quote RULES live in `calculateServiceQuote`, a pure function. No
// pricing logic is hardcoded in a React component.
//
// Three quote modes:
//   AUTO_QUOTE   — standard job, base_price × qty, instant total.
//   GUIDED_QUOTE — complicated job; returns a min/max range + guide
//                  questions; a human must confirm the final price.
//   MANUAL_QUOTE — owner/technician must evaluate; no computed price.
//
// The urgent fee ("คิวงานด่วน") is ALWAYS a separate line — never folded
// into the service base price.

import supabase from "@/lib/supabase";

// ---------- Types ----------------------------------------------------------

export type QuoteMode = "AUTO_QUOTE" | "GUIDED_QUOTE" | "MANUAL_QUOTE";

export const QUOTE_MODES: QuoteMode[] = [
  "AUTO_QUOTE",
  "GUIDED_QUOTE",
  "MANUAL_QUOTE",
];

/** One row of public.service_price_master, camelCased for the app. */
export type ServicePrice = {
  id: string;
  active: boolean;
  serviceCode: string;
  brand: string;
  branchScope: string;
  categoryTh: string;
  subcategoryTh: string | null;
  serviceNameTh: string;
  quoteMode: QuoteMode;
  basePrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  unit: string;
  defaultQty: number;
  difficultyLevel: string | null;
  materialGroup: string | null;
  urgentAllowed: boolean;
  urgentFeePerItem: number;
  promoEligible: boolean;
  requiresHumanVerify: boolean;
  guideQuestions: string[];
  customerNoteTh: string | null;
  staffNoteTh: string | null;
  sortOrder: number;
  version: string;
  source: string;
  sourceRow: number | null;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
};

export type QuoteLineKind = "service" | "urgent";

/** One charge line. The urgent fee is its own line — never merged. */
export type QuoteLine = {
  kind: QuoteLineKind;
  /** Display label — service name, or the urgent-fee label. */
  label: string;
  unitAmount: number;
  qty: number;
  amount: number;
};

export type QuoteCalculationResult = {
  serviceCode: string;
  serviceNameTh: string;
  quoteMode: QuoteMode;
  qty: number;
  /** service line, then the urgent line when applicable. */
  lines: QuoteLine[];
  /** Final total for AUTO_QUOTE; null when a human must finalize. */
  total: number | null;
  /** GUIDED_QUOTE range (inclusive of urgent). null for other modes. */
  minTotal: number | null;
  maxTotal: number | null;
  urgentApplied: boolean;
  urgentFee: number;
  /** True for GUIDED / MANUAL, or when the row flags requires_human_verify. */
  requiresHumanVerify: boolean;
  guideQuestions: string[];
  staffNoteTh: string | null;
  customerNoteTh: string | null;
  /** Thai notice telling staff what to do next (null for a clean AUTO). */
  noticeTh: string | null;
};

// ---------- Constants ------------------------------------------------------

/** Urgent fee is always shown under this label, as its own line. */
export const URGENT_LINE_LABEL_TH = "คิวงานด่วน";

export const MANUAL_QUOTE_NOTICE_TH =
  "ต้องประเมินโดยเจ้าของ/ช่างก่อนยืนยันราคา";

export const GUIDED_QUOTE_NOTICE_TH =
  "งานนี้ต้องตอบคำถามแนะนำ แล้วให้เจ้าของ/ช่างยืนยันราคาก่อน";

export const QUOTE_MODE_LABELS: Record<QuoteMode, { th: string; en: string }> = {
  AUTO_QUOTE: { th: "ราคาอัตโนมัติ", en: "Auto quote" },
  GUIDED_QUOTE: { th: "ราคาแบบมีคำถาม", en: "Guided quote" },
  MANUAL_QUOTE: { th: "ประเมินราคาเอง", en: "Manual quote" },
};

// ---------- Helpers --------------------------------------------------------

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toGuideQuestions(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
  }
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x).trim()).filter((s) => s.length > 0);
      }
    } catch {
      // Not JSON — treat as a newline-separated list.
    }
    return v
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/** Map a raw public.service_price_master row to the camelCased ServicePrice. */
export function rowToServicePrice(row: Record<string, unknown>): ServicePrice {
  const quoteModeRaw = String(row.quote_mode ?? "AUTO_QUOTE").toUpperCase();
  const quoteMode = (QUOTE_MODES as string[]).includes(quoteModeRaw)
    ? (quoteModeRaw as QuoteMode)
    : "AUTO_QUOTE";
  return {
    id: String(row.id ?? ""),
    active: row.active !== false,
    serviceCode: String(row.service_code ?? ""),
    brand: String(row.brand ?? "CARE_U"),
    branchScope: String(row.branch_scope ?? "ALL"),
    categoryTh: String(row.category_th ?? ""),
    subcategoryTh: row.subcategory_th ? String(row.subcategory_th) : null,
    serviceNameTh: String(row.service_name_th ?? ""),
    quoteMode,
    basePrice: toNum(row.base_price),
    minPrice: toNum(row.min_price),
    maxPrice: toNum(row.max_price),
    unit: String(row.unit ?? "ตัว"),
    defaultQty: toNum(row.default_qty) ?? 1,
    difficultyLevel: row.difficulty_level ? String(row.difficulty_level) : null,
    materialGroup: row.material_group ? String(row.material_group) : null,
    urgentAllowed: row.urgent_allowed !== false,
    urgentFeePerItem: toNum(row.urgent_fee_per_item) ?? 30,
    promoEligible: row.promo_eligible !== false,
    requiresHumanVerify: row.requires_human_verify === true,
    guideQuestions: toGuideQuestions(row.guide_questions),
    customerNoteTh: row.customer_note_th ? String(row.customer_note_th) : null,
    staffNoteTh: row.staff_note_th ? String(row.staff_note_th) : null,
    sortOrder: toNum(row.sort_order) ?? 999,
    version: String(row.version ?? "v1"),
    source: String(row.source ?? "GOOGLE_SHEET"),
    sourceRow: toNum(row.source_row),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    syncedAt: row.synced_at ? String(row.synced_at) : null,
  };
}

// ---------- Quote engine (pure — no DB, no React) --------------------------

/**
 * Calculate a quote for one service line. Pure: same inputs → same output,
 * so the intake UI, a receipt builder, and a future AI intake pipeline can
 * all share it.
 *
 *   AUTO_QUOTE   → total = base_price × qty (+ a separate urgent line).
 *   GUIDED_QUOTE → total = null; minTotal/maxTotal carry the range;
 *                  requiresHumanVerify = true; guide questions returned.
 *   MANUAL_QUOTE → no price at all; requiresHumanVerify = true.
 *
 * The urgent fee is emitted as its own QuoteLine (kind: "urgent",
 * label: "คิวงานด่วน") and is never folded into the service amount.
 */
export function calculateServiceQuote(
  service: ServicePrice,
  qty = 1,
  urgent = false
): QuoteCalculationResult {
  const safeQty =
    Number.isFinite(qty) && qty > 0
      ? qty
      : service.defaultQty > 0
        ? service.defaultQty
        : 1;

  const urgentApplied = urgent && service.urgentAllowed;
  const urgentFee = service.urgentFeePerItem;
  const urgentLine: QuoteLine | null = urgentApplied
    ? {
        kind: "urgent",
        label: URGENT_LINE_LABEL_TH,
        unitAmount: urgentFee,
        qty: safeQty,
        amount: round2(urgentFee * safeQty),
      }
    : null;

  const shared = {
    serviceCode: service.serviceCode,
    serviceNameTh: service.serviceNameTh,
    quoteMode: service.quoteMode,
    qty: safeQty,
    urgentApplied,
    urgentFee,
    guideQuestions: service.guideQuestions,
    staffNoteTh: service.staffNoteTh,
    customerNoteTh: service.customerNoteTh,
  };

  if (service.quoteMode === "AUTO_QUOTE") {
    const unit = service.basePrice ?? 0;
    const serviceLine: QuoteLine = {
      kind: "service",
      label: service.serviceNameTh,
      unitAmount: unit,
      qty: safeQty,
      amount: round2(unit * safeQty),
    };
    const lines = urgentLine ? [serviceLine, urgentLine] : [serviceLine];
    const total = round2(lines.reduce((sum, l) => sum + l.amount, 0));
    return {
      ...shared,
      lines,
      total,
      minTotal: total,
      maxTotal: total,
      requiresHumanVerify: service.requiresHumanVerify,
      noticeTh: null,
    };
  }

  if (service.quoteMode === "GUIDED_QUOTE") {
    const lo = service.minPrice ?? service.basePrice ?? 0;
    const hi = service.maxPrice ?? service.basePrice ?? lo;
    const serviceLine: QuoteLine = {
      kind: "service",
      label: service.serviceNameTh,
      unitAmount: lo,
      qty: safeQty,
      amount: round2(lo * safeQty),
    };
    const lines = urgentLine ? [serviceLine, urgentLine] : [serviceLine];
    const urgentAmount = urgentLine ? urgentLine.amount : 0;
    return {
      ...shared,
      lines,
      total: null, // a guided quote is a range until a human confirms it
      minTotal: round2(lo * safeQty + urgentAmount),
      maxTotal: round2(hi * safeQty + urgentAmount),
      requiresHumanVerify: true,
      noticeTh: GUIDED_QUOTE_NOTICE_TH,
    };
  }

  // MANUAL_QUOTE — no computed price; a human evaluates first.
  return {
    ...shared,
    lines: urgentLine ? [urgentLine] : [],
    total: null,
    minTotal: null,
    maxTotal: null,
    requiresHumanVerify: true,
    noticeTh: MANUAL_QUOTE_NOTICE_TH,
  };
}

// ---------- Data access (browser client; reads only) ----------------------

const SERVICE_PRICE_COLUMNS =
  "id, active, service_code, brand, branch_scope, category_th, subcategory_th, service_name_th, quote_mode, base_price, min_price, max_price, unit, default_qty, difficulty_level, material_group, urgent_allowed, urgent_fee_per_item, promo_eligible, requires_human_verify, guide_questions, customer_note_th, staff_note_th, sort_order, version, source, source_row, created_at, updated_at, synced_at";

export type ServicePriceFetchResult = {
  services: ServicePrice[];
  error: string | null;
};

/** Active catalog rows — what the intake form may consume. */
export async function getActiveServicePrices(): Promise<ServicePriceFetchResult> {
  const res = await supabase
    .from("service_price_master")
    .select(SERVICE_PRICE_COLUMNS)
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .order("service_name_th", { ascending: true });
  if (res.error) {
    console.warn("[servicePriceMaster] active read failed", res.error.message);
    return { services: [], error: res.error.message };
  }
  return {
    services: ((res.data ?? []) as Array<Record<string, unknown>>).map(
      rowToServicePrice
    ),
    error: null,
  };
}

/** Every catalog row (active + inactive) — for the Pricing Master admin page. */
export async function getAllServicePrices(): Promise<ServicePriceFetchResult> {
  const res = await supabase
    .from("service_price_master")
    .select(SERVICE_PRICE_COLUMNS)
    .order("sort_order", { ascending: true })
    .order("service_name_th", { ascending: true });
  if (res.error) {
    console.warn("[servicePriceMaster] catalog read failed", res.error.message);
    return { services: [], error: res.error.message };
  }
  return {
    services: ((res.data ?? []) as Array<Record<string, unknown>>).map(
      rowToServicePrice
    ),
    error: null,
  };
}

/** Look up one service by its code. Returns null when missing. */
export async function getServicePriceByCode(
  serviceCode: string
): Promise<ServicePrice | null> {
  const code = serviceCode.trim();
  if (!code) return null;
  const res = await supabase
    .from("service_price_master")
    .select(SERVICE_PRICE_COLUMNS)
    .eq("service_code", code)
    .maybeSingle();
  if (res.error || !res.data) return null;
  return rowToServicePrice(res.data as Record<string, unknown>);
}
