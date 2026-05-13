// Pricing service — the one place that turns "what is the customer paying?"
// into a number. Every screen that needs a quote / preview / receipt total
// goes through here. Keeps pricing rules out of UI files.
//
// Layered design (matches docs/PRICING_RULES.md):
//   A) pricing data       — fetchPricingCatalog (lib/pricingDb)
//   B) pricing rules      — calculateUrgentFee, base price selection
//   C) promotion rules    — calculatePromotionDiscount (delegates to
//                            lib/pricing::computeDiscount)
//   D) receipt display    — buildReceiptLines (one line per fee component)

import { computeDiscount, getPromotionByCode, type ServiceItem } from "@/lib/pricing";
import {
  fetchPricingCatalog,
  type ServicePriceRow,
  type EffectivePricingContext,
} from "@/lib/pricingDb";

const DEFAULT_URGENT_FEE = 30;

export type PriceContext = EffectivePricingContext & {
  /** Optional businessType to filter the catalog when both brands' codes overlap. */
  businessType?: "care_u" | "ezy_repair";
};

export type PriceQuote = {
  /** Unit price × quantity (pre-urgent, pre-discount). */
  subtotal: number;
  /** Urgent surcharge applied as a separate line. */
  urgentFee: number;
  /** Discount from the chosen promotion (or manual override). */
  discount: number;
  /** subtotal + urgentFee − discount, clamped to ≥ 0. */
  total: number;
  /** Promotion that was applied (resolved label, or null when none). */
  appliedPromotion: { code: string; nameTh: string } | null;
  /** Reasoning trail for receipts / audit, in display order. */
  lines: ReceiptLine[];
};

export type ReceiptLine = {
  key: "subtotal" | "urgent" | "discount" | "total";
  labelTh: string;
  amount: number;
  hint?: string;
};

// ---------- A. Data layer wrapper -----------------------------------------

/**
 * Look up the currently-effective service row (branch-biased). Returns null
 * when the code isn't in the catalog AND isn't in the hardcoded fallback.
 */
export async function getServicePrice(
  serviceCode: string,
  ctx: PriceContext = {}
): Promise<ServicePriceRow | ServiceItem | null> {
  const cat = await fetchPricingCatalog(ctx);
  // Prefer the DB row (already branch/brand-resolved by pricingDb).
  const dbHit = cat.rows.find(
    (r) =>
      r.service_code === serviceCode &&
      r.is_active &&
      (r.effective_to === null || r.effective_to === undefined)
  );
  if (dbHit) return dbHit;
  // Fall back to the merged catalog (hardcoded SERVICES path).
  const merged = cat.services.find((s) => s.code === serviceCode);
  return merged ?? null;
}

// ---------- B. Pricing rules ----------------------------------------------

/**
 * Resolve the urgent surcharge to apply. Priority:
 *   1. explicit override (staff typed a custom amount)
 *   2. service row's urgent_fee_default (DB row only)
 *   3. global default = 30 THB
 */
export function calculateUrgentFee(
  service: ServicePriceRow | ServiceItem | null | undefined,
  urgent: boolean,
  override?: number | null
): number {
  if (!urgent) return 0;
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  // DB row carries urgent_fee_default; hardcoded ServiceItem carries the
  // optional urgentFeeDefault field added in 20260519.
  const fromRow = service && "urgent_fee_default" in (service as Record<string, unknown>)
    ? Number((service as ServicePriceRow).urgent_fee_default)
    : null;
  if (fromRow !== null && Number.isFinite(fromRow) && fromRow > 0) {
    return Math.floor(fromRow);
  }
  const fromItem = service && "urgentFeeDefault" in (service as Record<string, unknown>)
    ? Number((service as ServiceItem).urgentFeeDefault ?? 0)
    : 0;
  if (fromItem > 0) return Math.floor(fromItem);
  return DEFAULT_URGENT_FEE;
}

// ---------- C. Promotion rules --------------------------------------------

/**
 * Compute the promotion discount for the given subtotal. Wraps the existing
 * computeDiscount in lib/pricing.ts so future engine changes (e.g. DB-backed
 * promotions) only need to update one path.
 *
 * `serviceCode` is consulted against the promotion's excludedServiceCodes —
 * if the line is excluded, the discount is 0.
 */
export function calculatePromotionDiscount(
  subtotal: number,
  promotionCode: string | null | undefined,
  options?: { manualDiscount?: number; serviceCode?: string | null }
): number {
  const promo = getPromotionByCode(promotionCode);
  if (
    promo &&
    options?.serviceCode &&
    promo.excludedServiceCodes?.includes(options.serviceCode)
  ) {
    return 0;
  }
  return computeDiscount(subtotal, promotionCode, options?.manualDiscount);
}

// ---------- D. Final-price assembly + receipt lines -----------------------

export type FinalPriceInput = {
  unitPrice: number;
  quantity: number;
  urgent: boolean;
  urgentFeeOverride?: number | null;
  promotionCode?: string | null;
  manualDiscount?: number;
  service?: ServicePriceRow | ServiceItem | null;
  serviceCode?: string | null;
};

/**
 * The single function every screen should call when it wants "what is the
 * final number the customer pays?".
 */
export function calculateFinalPrice(input: FinalPriceInput): PriceQuote {
  const unitPrice = Math.max(0, Number(input.unitPrice) || 0);
  const quantity = Math.max(1, Math.floor(Number(input.quantity) || 1));
  const subtotal = unitPrice * quantity;

  const urgentFee = calculateUrgentFee(
    input.service ?? null,
    input.urgent,
    input.urgentFeeOverride ?? undefined
  );
  const discount = calculatePromotionDiscount(subtotal, input.promotionCode, {
    manualDiscount: input.manualDiscount,
    serviceCode: input.serviceCode ?? null,
  });
  const total = Math.max(0, subtotal + urgentFee - discount);

  const promo = getPromotionByCode(input.promotionCode);
  const appliedPromotion =
    promo && promo.code !== "NONE" && discount > 0
      ? { code: promo.code, nameTh: promo.nameTh }
      : null;

  const lines: ReceiptLine[] = [
    {
      key: "subtotal",
      labelTh: `ยอดก่อนส่วนลด (${quantity} × ฿${unitPrice.toLocaleString()})`,
      amount: subtotal,
    },
    {
      key: "urgent",
      labelTh: "คิวงานด่วน",
      amount: urgentFee,
      hint: urgentFee > 0 ? undefined : "ไม่มีค่างานด่วน",
    },
    {
      key: "discount",
      labelTh: appliedPromotion
        ? `ส่วนลด (${appliedPromotion.nameTh})`
        : "ส่วนลด",
      amount: -discount,
    },
    { key: "total", labelTh: "ยอดรวมสุทธิ", amount: total },
  ];

  return { subtotal, urgentFee, discount, total, appliedPromotion, lines };
}
