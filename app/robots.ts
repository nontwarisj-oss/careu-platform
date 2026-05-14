// Robots policy. Allow crawling of the public-facing site, block every
// operator-only surface. Reserved subpaths (/api, /admin, /orders,
// /customers, /pricing, etc.) are explicitly disallowed so a crawler
// doesn't waste budget on the OPS routes.

import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://careu.example.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: [
          "/website",
          "/branches",
          "/services",
          "/track",
          "/quote",
          "/about",
          "/contact",
        ],
        disallow: [
          "/api",
          "/admin",
          "/orders",
          "/customers",
          "/intake",
          "/invoices",
          "/expenses",
          "/reports",
          "/pricing",
          "/login",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
