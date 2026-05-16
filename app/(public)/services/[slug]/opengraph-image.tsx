// Per-service OpenGraph image — Phase 27C.
//
// One card per /services/[slug]. Prerendered for every known slug via
// generateStaticParams (mirrors the page). An unknown slug falls back
// to a generic Care U service card rather than 404-ing the image.

import { ImageResponse } from "next/og";
import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from "@/lib/ogTemplate";
import { getServiceContent, allServiceSlugs } from "@/lib/serviceContent";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Care U service";

export function generateStaticParams(): Array<{ slug: string }> {
  return allServiceSlugs().map((slug) => ({ slug }));
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const svc = getServiceContent(slug);
  return new ImageResponse(
    ogCard({
      brand: "careu",
      eyebrow: "Care U · Service",
      title: svc ? svc.titleEn : "Care U service",
      subtitle: svc
        ? `From THB ${svc.priceRangeThb} · free assessment`
        : "Garment alteration & repair services",
      footer: "Free online quote",
    }),
    { ...OG_SIZE }
  );
}
