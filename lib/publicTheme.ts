// Public website theme system. Single source of truth for brand colours,
// labels, and headers used by /website, /branches/[code], /services,
// /track, /quote, /about, /contact.
//
// Two layers:
//   1. Per-brand defaults (BRAND_THEMES) — Care U and Ezy Repair.
//   2. Per-branch override pulled from public.branches.accent_class +
//      tagline + logo_path (via the DB-mirror migration 20260533). A
//      single-branch landing page (`/branches/[code]`) uses the override;
//      cross-brand pages (the global `/website` home) use the default
//      Care U theme.
//
// Pure data — safe to import from server or client code.

export type BrandKey = "careu" | "ezy";

export type PublicTheme = {
  brand: BrandKey;
  /** Display brand name. */
  brandLabel: string;
  /** Marketing one-liner shown in the page header. */
  tagline: string;
  /** Tailwind gradient classes for the accent strip. Designed to work
   *  with `bg-gradient-to-r ${accentClass}`. */
  accentClass: string;
  /** Solid accent colour for primary buttons / chips. */
  primaryButtonClass: string;
  /** Logo path served from /public. */
  logoPath: string;
  /** Override hint for the page-header microcopy. */
  microcopy: { th: string; en: string };
};

export const BRAND_THEMES: Record<BrandKey, PublicTheme> = {
  careu: {
    brand: "careu",
    brandLabel: "Care U",
    tagline: "แคร์ยู ดูแลเสื้อผ้าคุณด้วยใจ",
    accentClass: "from-green-700 to-emerald-600",
    primaryButtonClass:
      "bg-green-700 hover:bg-green-800 text-white",
    logoPath: "/logos/c24-careu.svg",
    microcopy: {
      th: "ร้านซ่อมผ้า / ดัดแปลง / ซักรีดมืออาชีพ — บริการครบทุกความต้องการ",
      en: "Garment alteration / repair / dry cleaning — professional service.",
    },
  },
  ezy: {
    brand: "ezy",
    brandLabel: "Ezy Repair",
    tagline: "ซ่อมไว ได้ดั่งใจ แค่ทักไลน์",
    accentClass: "from-green-800 to-lime-700",
    primaryButtonClass:
      "bg-emerald-700 hover:bg-emerald-800 text-white",
    logoPath: "/logos/ezy-repair.svg",
    microcopy: {
      th: "ซ่อมรองเท้า / กระเป๋า / กระเป๋าเดินทาง — รับงานหน้าร้าน + ส่งทาง LINE",
      en: "Shoe / bag / luggage repair — counter drop-off or LINE.",
    },
  },
};

/** Branch UI metadata pulled from public.branches (post-`20260533`). */
export type BranchTheme = {
  branchCode: string;
  shortLabel: string;
  shortName: string;
  receiptName: string;
  tagline: string | null;
  address: string | null;
  phone: string | null;
  logoPath: string;
  accentClass: string;
  brand: BrandKey;
};

/**
 * Merge a branch row over the brand default. Per-field fallback so a
 * partial DB row never renders an empty header. Mirrors the same fallback
 * pattern used in `lib/branchContext.tsx::mapDbRow`.
 */
export function themeForBranch(branch: BranchTheme | null): PublicTheme {
  const baseBrand: BrandKey =
    branch?.brand && (branch.brand === "careu" || branch.brand === "ezy")
      ? branch.brand
      : "careu";
  const base = BRAND_THEMES[baseBrand];
  if (!branch) return base;
  return {
    ...base,
    tagline: branch.tagline ?? base.tagline,
    accentClass: branch.accentClass ?? base.accentClass,
    logoPath: branch.logoPath ?? base.logoPath,
  };
}

export function defaultBrandTheme(): PublicTheme {
  return BRAND_THEMES.careu;
}
