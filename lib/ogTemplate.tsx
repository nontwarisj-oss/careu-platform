// Shared OpenGraph image template — Phase 27C.
//
// Rendered by the `opengraph-image.tsx` route files via `next/og`
// `ImageResponse` (Satori). Satori only understands flexbox layout +
// inline styles, so every node here carries `display: flex` and a
// literal style object — no Tailwind, no CSS classes.
//
// IMPORTANT: text is Latin-only on purpose. The default `next/og`
// font does not ship Thai glyphs; rendering Thai here would produce
// tofu boxes. Branch codes, English service titles, and brand labels
// are all Latin — those are what the cards display. A bundled Thai
// font is a future enhancement.

import type { ReactElement } from "react";

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";

export type OgBrand = "careu" | "ezy";

// Brand accent pairs as hex — Satori cannot resolve Tailwind gradient
// classes, so the brand colours from lib/publicTheme are mirrored here.
const OG_ACCENT: Record<OgBrand, { from: string; to: string }> = {
  careu: { from: "#15803d", to: "#059669" },
  ezy: { from: "#166534", to: "#4d7c0f" },
};

export type OgCardInput = {
  brand: OgBrand;
  /** Small uppercase eyebrow, e.g. "Care U · Service". */
  eyebrow: string;
  /** Large headline. */
  title: string;
  /** One-line supporting text. */
  subtitle: string;
  /** Footer strip text, e.g. "Free online quote". */
  footer: string;
};

/** Build the OG card element passed to `new ImageResponse(...)`. */
export function ogCard(input: OgCardInput): ReactElement {
  const accent = OG_ACCENT[input.brand] ?? OG_ACCENT.careu;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        padding: 80,
        color: "#ffffff",
        backgroundColor: accent.from,
        backgroundImage: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
        justifyContent: "space-between",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: 8,
          textTransform: "uppercase",
          opacity: 0.92,
        }}
      >
        {input.eyebrow}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            fontSize: 80,
            fontWeight: 800,
            lineHeight: 1.08,
          }}
        >
          {input.title}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 34,
            marginTop: 28,
            opacity: 0.9,
            maxWidth: 940,
          }}
        >
          {input.subtitle}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 28,
            fontWeight: 700,
            opacity: 0.85,
          }}
        >
          {input.footer}
        </div>
        <div
          style={{
            display: "flex",
            height: 56,
            width: 56,
            borderRadius: 16,
            backgroundColor: "rgba(255,255,255,0.18)",
          }}
        />
      </div>
    </div>
  );
}
