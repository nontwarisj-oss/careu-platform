// Public SEO helpers — Phase 27C.
//
// Single source of truth for the public site's absolute origin and for
// the canonical URLs each page advertises. `NEXT_PUBLIC_SITE_URL` is the
// production host; the placeholder keeps local builds + the sitemap
// stable when the env var is not yet set.
//
// Pure data — safe to import from server components, route handlers,
// and `generateMetadata`.

import type { Metadata } from "next";

/** Public site origin, no trailing slash. */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://careu.example.com"
).replace(/\/+$/, "");

/** Resolve a site-relative path to an absolute URL. */
export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * `Metadata["alternates"]` carrying a canonical URL for the given path.
 * Every public page sets one so crawlers never index a query-string or
 * trailing-slash variant as a separate page.
 */
export function canonical(path: string): Metadata["alternates"] {
  return { canonical: absoluteUrl(path) };
}

/** A schema.org BreadcrumbList JSON-LD object for the given trail. */
export function breadcrumbJsonLd(
  trail: Array<{ name: string; path: string }>
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((step, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: step.name,
      item: absoluteUrl(step.path),
    })),
  };
}
