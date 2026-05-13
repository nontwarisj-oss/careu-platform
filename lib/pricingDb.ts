// Pricing data access. Single entry point for reading the active service
// catalog at order time, with progressive fallback so the app keeps working
// regardless of migration state:
//
//   1. Query public.service_prices for currently-effective + is_active rows.
//   2. Merge with the hardcoded SERVICES array — DB rows win on shared codes.
//   3. If the DB query fails (missing table, schema cache, network), fall
//      back entirely to the hardcoded SERVICES + log a console warning so
//      the operator can see why prices look stale.
//
// Column naming reflects 20260523_pricing_engine.sql:
//   display_name (was service_name), description (was description_template),
//   pricing_type (was price_type), is_active (was active). branch_id is uuid
//   referencing public.branches(id). business_type ('care_u' | 'ezy_repair'),
//   sort_order, updated_at, updated_by added.

import supabase from "@/lib/supabase";
import {
  SERVICES,
  SERVICE_CATEGORIES,
  type ServiceCategory,
  type ServiceCategoryKey,
  type ServiceItem,
} from "@/lib/pricing";

export type ServicePriceRow = {
  id: string;
  service_code: string;
  category: string;
  business_type: "care_u" | "ezy_repair";
  display_name: string;
  description: string | null;
  base_price: number | string | null;
  pricing_type: "fixed" | "estimate_required";
  urgent_fee_default: number | string;
  is_active: boolean;
  sort_order: number;
  branch_id: string | null;       // uuid (branches.id) — null = global
  brand_id: string | null;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
};

export type EffectivePricingContext = {
  /** Pass either a branches.id (uuid) OR a branches.code (slug); resolved below. */
  branchId?: string | null;
  brandId?: string | null;
  /** Override "now" for tests / time-travel. */
  asOf?: Date;
  /** Filter to one business type when both share codes (rare). */
  businessType?: "care_u" | "ezy_repair";
};

const PRICING_COLUMNS =
  "id, service_code, category, business_type, display_name, description, base_price, pricing_type, urgent_fee_default, is_active, sort_order, branch_id, brand_id, effective_from, effective_to, created_at, created_by, updated_at, updated_by";

export type PricingFetchResult = {
  /** Merged catalog ready for the UI / SmartOrderForm. */
  services: ServiceItem[];
  /** Raw DB rows for the /pricing admin page (includes inactive + future). */
  rows: ServicePriceRow[];
  /** Hardcoded service codes that the DB does NOT yet cover. */
  fallbackOnly: string[];
  /** Categories that exist in the catalog. */
  categories: ServiceCategory[];
  error: string | null;
};

function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** True when `now` falls inside [effective_from, effective_to). */
function isCurrent(row: ServicePriceRow, now: Date): boolean {
  if (!row.is_active) return false;
  const from = new Date(row.effective_from);
  if (Number.isFinite(from.getTime()) && from > now) return false;
  if (row.effective_to) {
    const to = new Date(row.effective_to);
    if (Number.isFinite(to.getTime()) && to <= now) return false;
  }
  return true;
}

/** Choose the more-specific row when two effective rows share a service_code. */
function chooseMoreSpecific(
  a: ServicePriceRow,
  b: ServicePriceRow,
  ctx: EffectivePricingContext
): ServicePriceRow {
  const score = (r: ServicePriceRow): number => {
    let s = 0;
    if (ctx.branchId && r.branch_id === ctx.branchId) s += 4;
    if (ctx.brandId && r.brand_id === ctx.brandId) s += 2;
    if (!r.branch_id && !r.brand_id) s += 0; // global fallback
    return s;
  };
  const sa = score(a);
  const sb = score(b);
  if (sa !== sb) return sa > sb ? a : b;
  // Tie-break by most recent effective_from
  return new Date(a.effective_from) >= new Date(b.effective_from) ? a : b;
}

function rowToServiceItem(row: ServicePriceRow): ServiceItem {
  const basePrice =
    row.pricing_type === "estimate_required" ? null : toNum(row.base_price);
  const urgent = toNum(row.urgent_fee_default);
  return {
    code: row.service_code,
    category: row.category as ServiceCategoryKey,
    nameTh: row.display_name,
    nameEn: row.display_name, // EN label not persisted yet; reuse Thai name
    basePrice,
    templateTh: row.description ?? "",
    isSpecial: row.pricing_type === "estimate_required",
    urgentFeeDefault: urgent && urgent > 0 ? urgent : undefined,
  };
}

/**
 * Load the catalog. Pass branchId/brandId to bias the per-row resolution
 * toward branch- or brand-specific overrides; omit them to get the global
 * view (what the /pricing admin page wants).
 */
export async function fetchPricingCatalog(
  ctx: EffectivePricingContext = {}
): Promise<PricingFetchResult> {
  const now = ctx.asOf ?? new Date();
  let rows: ServicePriceRow[] = [];
  let error: string | null = null;

  const res = await supabase
    .from("service_prices")
    .select(PRICING_COLUMNS)
    .order("sort_order", { ascending: true })
    .order("service_code", { ascending: true })
    .order("effective_from", { ascending: false });

  if (res.error) {
    error = res.error.message;
    console.warn(
      "[pricingDb] service_prices query failed — falling back to hardcoded SERVICES",
      res.error.message
    );
  } else {
    rows = (res.data ?? []) as ServicePriceRow[];
  }

  // Resolve "current effective row per code", branch/brand/business-type aware.
  const currentByCode = new Map<string, ServicePriceRow>();
  for (const row of rows) {
    if (!isCurrent(row, now)) continue;
    if (ctx.businessType && row.business_type !== ctx.businessType) continue;
    const existing = currentByCode.get(row.service_code);
    if (!existing) {
      currentByCode.set(row.service_code, row);
    } else {
      currentByCode.set(
        row.service_code,
        chooseMoreSpecific(existing, row, ctx)
      );
    }
  }

  // Merge: DB rows win on shared codes; hardcoded fills the gaps.
  const merged = new Map<string, ServiceItem>();
  for (const s of SERVICES) merged.set(s.code, s);
  for (const [code, row] of currentByCode) {
    merged.set(code, rowToServiceItem(row));
  }

  const fallbackOnly = SERVICES.filter((s) => !currentByCode.has(s.code)).map(
    (s) => s.code
  );

  return {
    services: Array.from(merged.values()),
    rows,
    fallbackOnly,
    categories: SERVICE_CATEGORIES,
    error,
  };
}

export type ServicePriceInput = {
  service_code: string;
  category: string;
  business_type?: "care_u" | "ezy_repair";
  display_name: string;
  description?: string | null;
  base_price?: number | null;
  pricing_type: "fixed" | "estimate_required";
  urgent_fee_default?: number;
  is_active?: boolean;
  sort_order?: number;
  branch_id?: string | null;   // uuid or null
  brand_id?: string | null;
  created_by?: string | null;  // uuid or null
};

function toInsertPayload(input: ServicePriceInput) {
  return {
    service_code: input.service_code.trim(),
    category: input.category,
    business_type: input.business_type ?? "care_u",
    display_name: input.display_name.trim(),
    description: input.description ?? null,
    base_price:
      input.pricing_type === "estimate_required"
        ? null
        : input.base_price ?? null,
    pricing_type: input.pricing_type,
    urgent_fee_default: input.urgent_fee_default ?? 30,
    is_active: input.is_active ?? true,
    sort_order: input.sort_order ?? 0,
    branch_id: input.branch_id ?? null,
    brand_id: input.brand_id ?? null,
    created_by: input.created_by ?? null,
  };
}

/**
 * Insert a brand-new version. The caller is responsible for closing any
 * previous version of the same service_code first (via `closeServicePrice`)
 * when this represents a "new effective price from today" transition.
 */
export async function insertServicePrice(
  input: ServicePriceInput
): Promise<{ id: string | null; error: string | null }> {
  const payload = toInsertPayload(input);
  const res = await supabase
    .from("service_prices")
    .insert(payload)
    .select("id")
    .single();
  if (res.error) return { id: null, error: res.error.message };
  return { id: (res.data as { id: string }).id, error: null };
}

/** Quick mutation of an existing row (no version bump). Use for typo fixes. */
export async function updateServicePrice(
  id: string,
  patch: Partial<ServicePriceInput>
): Promise<{ error: string | null }> {
  const writable: Record<string, unknown> = { ...patch };
  if (patch.pricing_type === "estimate_required") writable.base_price = null;
  const res = await supabase
    .from("service_prices")
    .update(writable)
    .eq("id", id);
  if (res.error) return { error: res.error.message };
  return { error: null };
}

/**
 * Close a row — disables it and stamps effective_to. Use this before
 * inserting a replacement so the audit trail records the transition.
 */
export async function closeServicePrice(
  id: string
): Promise<{ error: string | null }> {
  const res = await supabase
    .from("service_prices")
    .update({ is_active: false, effective_to: new Date().toISOString() })
    .eq("id", id);
  if (res.error) return { error: res.error.message };
  return { error: null };
}
