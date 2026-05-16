// Per-branch OpenGraph image — Phase 27C.
//
// Rendered on demand (the branch detail page is itself dynamic). The
// card uses the branch code + brand — both Latin — so no Thai font is
// needed. Any DB hiccup degrades to a generic Care U card; the image
// route never throws.

import { ImageResponse } from "next/og";
import {
  ogCard,
  OG_SIZE,
  OG_CONTENT_TYPE,
  type OgBrand,
} from "@/lib/ogTemplate";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Care U branch";

export default async function Image({
  params,
}: {
  params: Promise<{ branchCode: string }>;
}) {
  const { branchCode } = await params;

  let brand: OgBrand = "careu";
  let title = "Care U branch";
  try {
    const admin = getSupabaseAdmin();
    if (admin) {
      const { data } = await admin
        .from("branches")
        .select("code, brand")
        .eq("code", branchCode)
        .eq("is_active", true)
        .maybeSingle();
      if (data) {
        brand = (data as { brand: string | null }).brand === "ezy"
          ? "ezy"
          : "careu";
        title = `Branch ${(data as { code: string }).code}`;
      }
    }
  } catch {
    // Fall through to the generic card — never fail the image route.
  }

  return new ImageResponse(
    ogCard({
      brand,
      eyebrow: brand === "ezy" ? "Ezy Repair" : "Care U",
      title,
      subtitle:
        brand === "ezy"
          ? "Shoe · bag · luggage repair — counter drop-off or LINE"
          : "Garment alteration · repair · dry cleaning",
      footer: "Visit us · online quote available",
    }),
    { ...OG_SIZE }
  );
}
