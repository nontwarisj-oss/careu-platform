// Google Sheet contract for the Pricing Master sync.
//
// The "Service_Prices" tab is the easy editing surface; the owner-only sync
// route reads it and upserts rows into public.service_price_master.
//
// This module is the SINGLE place that knows the sheet's column layout and
// how to coerce its text cells into typed values — so the route stays thin
// and the contract is documented in code (see also docs/SERVICE_PRICES_SHEET.md).
//
// Rows are matched by HEADER NAME, not column position, so inserting a
// column in the sheet never silently shifts the mapping.

import { QUOTE_MODES, type QuoteMode } from "@/lib/servicePriceMaster";

/** Tab the catalog is edited in. */
export const SERVICE_PRICES_SHEET_NAME = "Service_Prices";

/** Expected header row, in order. `last_updated_by` is sheet-only metadata
 *  (no DB column); `synced_at` in the sheet is informational — the sync
 *  route stamps service_price_master.synced_at itself. */
export const SERVICE_PRICES_SHEET_COLUMNS = [
  "active",
  "service_code",
  "brand",
  "branch_scope",
  "category_th",
  "subcategory_th",
  "service_name_th",
  "quote_mode",
  "base_price",
  "min_price",
  "max_price",
  "unit",
  "default_qty",
  "difficulty_level",
  "material_group",
  "urgent_allowed",
  "urgent_fee_per_item",
  "promo_eligible",
  "requires_human_verify",
  "guide_questions",
  "customer_note_th",
  "staff_note_th",
  "sort_order",
  "version",
  "last_updated_by",
  "synced_at",
] as const;

/** Upsert payload — keys are public.service_price_master column names. */
export type ServicePriceUpsert = {
  active: boolean;
  service_code: string;
  brand: string;
  branch_scope: string;
  category_th: string;
  subcategory_th: string | null;
  service_name_th: string;
  quote_mode: QuoteMode;
  base_price: number | null;
  min_price: number | null;
  max_price: number | null;
  unit: string;
  default_qty: number;
  difficulty_level: string | null;
  material_group: string | null;
  urgent_allowed: boolean;
  urgent_fee_per_item: number;
  promo_eligible: boolean;
  requires_human_verify: boolean;
  guide_questions: string[];
  customer_note_th: string | null;
  staff_note_th: string | null;
  sort_order: number;
  version: string;
  source: string;
  source_row: number;
  synced_at: string;
};

export type ParseRowResult =
  | { ok: true; payload: ServicePriceUpsert }
  | { ok: false; reason: string };

// ---------- Cell coercion --------------------------------------------------

const TRUE_TOKENS = new Set(["true", "1", "yes", "y", "ใช่", "x", "✓"]);
const FALSE_TOKENS = new Set(["false", "0", "no", "n", "ไม่", "ไม่ใช่", ""]);

/** Parse a spreadsheet boolean cell. Unknown text falls back to `fallback`. */
export function parseSheetBoolean(value: string | undefined, fallback: boolean): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (TRUE_TOKENS.has(v)) return true;
  if (FALSE_TOKENS.has(v)) return false;
  return fallback;
}

/** Parse a numeric cell. Blank/invalid → null. Strips ฿, commas, spaces. */
export function parseSheetNumber(value: string | undefined): number | null {
  const raw = (value ?? "").trim();
  if (raw === "") return null;
  const cleaned = raw.replace(/[,\s฿]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** guide_questions accepts a JSON array OR a newline / "|" separated list. */
export function parseSheetGuideQuestions(value: string | undefined): string[] {
  const raw = (value ?? "").trim();
  if (raw === "") return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x).trim()).filter((s) => s.length > 0);
      }
    } catch {
      // fall through to delimiter parsing
    }
  }
  return raw
    .split(/\r?\n|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function cleanText(value: string | undefined): string {
  return (value ?? "").trim();
}

function optionalText(value: string | undefined): string | null {
  const v = cleanText(value);
  return v === "" ? null : v;
}

// ---------- Row → upsert payload ------------------------------------------

/**
 * Validate + coerce one sheet row (already keyed by lowercased header) into
 * a service_price_master upsert payload.
 *
 *   • Required (NOT NULL, no default): service_code, category_th,
 *     service_name_th, quote_mode. A missing one → { ok:false }.
 *   • quote_mode must be AUTO_QUOTE / GUIDED_QUOTE / MANUAL_QUOTE.
 *   • Everything else falls back to the table's defaults when blank.
 *
 * `rowNumber` is the 1-based sheet row (header = 1) — stored as source_row.
 */
export function parseSheetServicePriceRow(
  record: Record<string, string>,
  rowNumber: number
): ParseRowResult {
  const serviceCode = cleanText(record.service_code);
  if (!serviceCode) {
    return { ok: false, reason: `แถว ${rowNumber}: ไม่มี service_code` };
  }
  const categoryTh = cleanText(record.category_th);
  if (!categoryTh) {
    return {
      ok: false,
      reason: `แถว ${rowNumber} (${serviceCode}): ไม่มี category_th`,
    };
  }
  const serviceNameTh = cleanText(record.service_name_th);
  if (!serviceNameTh) {
    return {
      ok: false,
      reason: `แถว ${rowNumber} (${serviceCode}): ไม่มี service_name_th`,
    };
  }
  const quoteModeRaw = cleanText(record.quote_mode).toUpperCase();
  if (!(QUOTE_MODES as string[]).includes(quoteModeRaw)) {
    return {
      ok: false,
      reason: `แถว ${rowNumber} (${serviceCode}): quote_mode "${
        record.quote_mode ?? ""
      }" ไม่ถูกต้อง — ต้องเป็น AUTO_QUOTE / GUIDED_QUOTE / MANUAL_QUOTE`,
    };
  }

  const brand = cleanText(record.brand) || "CARE_U";
  const branchScope = cleanText(record.branch_scope) || "ALL";
  const unit = cleanText(record.unit) || "ตัว";
  const defaultQty = parseSheetNumber(record.default_qty);
  const urgentFee = parseSheetNumber(record.urgent_fee_per_item);
  const sortOrder = parseSheetNumber(record.sort_order);
  const version = cleanText(record.version) || "v1";

  return {
    ok: true,
    payload: {
      active: parseSheetBoolean(record.active, true),
      service_code: serviceCode,
      brand,
      branch_scope: branchScope,
      category_th: categoryTh,
      subcategory_th: optionalText(record.subcategory_th),
      service_name_th: serviceNameTh,
      quote_mode: quoteModeRaw as QuoteMode,
      base_price: parseSheetNumber(record.base_price),
      min_price: parseSheetNumber(record.min_price),
      max_price: parseSheetNumber(record.max_price),
      unit,
      default_qty: defaultQty !== null && defaultQty > 0 ? defaultQty : 1,
      difficulty_level: optionalText(record.difficulty_level),
      material_group: optionalText(record.material_group),
      urgent_allowed: parseSheetBoolean(record.urgent_allowed, true),
      urgent_fee_per_item: urgentFee !== null && urgentFee >= 0 ? urgentFee : 30,
      promo_eligible: parseSheetBoolean(record.promo_eligible, true),
      requires_human_verify: parseSheetBoolean(
        record.requires_human_verify,
        false
      ),
      guide_questions: parseSheetGuideQuestions(record.guide_questions),
      customer_note_th: optionalText(record.customer_note_th),
      staff_note_th: optionalText(record.staff_note_th),
      sort_order: sortOrder !== null ? Math.trunc(sortOrder) : 999,
      version,
      source: "GOOGLE_SHEET",
      source_row: rowNumber,
      synced_at: new Date().toISOString(),
    },
  };
}
