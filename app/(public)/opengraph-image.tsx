// Default OpenGraph image for the public site — Phase 27C.
//
// Applies to every route in the (public) group that does not declare
// its own opengraph-image (homepage, /services index, /branches index,
// /about, /contact, /track, /quote). Branch + service detail pages
// override this with their own dynamic cards.

import { ImageResponse } from "next/og";
import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from "@/lib/ogTemplate";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Care U — บริการดูแลเสื้อผ้า ซ่อมรองเท้า กระเป๋า";

export default function Image() {
  return new ImageResponse(
    ogCard({
      brand: "careu",
      eyebrow: "Care U",
      title: "Garment care & repair",
      subtitle:
        "Alteration · zip & repair · shoe & bag care — multiple Bangkok branches",
      footer: "Online quote & job tracking",
    }),
    { ...OG_SIZE }
  );
}
