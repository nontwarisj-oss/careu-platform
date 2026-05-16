// Sitemap for the public website. Dynamic branch + service URLs.
// Crawlers respect the priority hints but the real signal is the URL list
// itself — that's what we control here.

import type { MetadataRoute } from "next";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { allServiceSlugs } from "@/lib/serviceContent";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://careu.example.com";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();

  const staticPages: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/website`, lastModified, priority: 1.0 },
    { url: `${SITE_URL}/branches`, lastModified, priority: 0.9 },
    { url: `${SITE_URL}/services`, lastModified, priority: 0.8 },
    { url: `${SITE_URL}/track`, lastModified, priority: 0.7 },
    { url: `${SITE_URL}/quote`, lastModified, priority: 0.7 },
    { url: `${SITE_URL}/about`, lastModified, priority: 0.5 },
    { url: `${SITE_URL}/contact`, lastModified, priority: 0.5 },
  ];

  // Dynamic per-service SEO pages.
  const servicePages: MetadataRoute.Sitemap = allServiceSlugs().map(
    (slug) => ({
      url: `${SITE_URL}/services/${slug}`,
      lastModified,
      priority: 0.7,
    })
  );

  const admin = getSupabaseAdmin();
  if (!admin) return [...staticPages, ...servicePages];

  const { data, error } = await admin
    .from("branches")
    .select("code")
    .eq("is_active", true);
  if (error || !data) return [...staticPages, ...servicePages];

  const branchPages: MetadataRoute.Sitemap = (data as Array<{ code: string }>).map(
    (b) => ({
      url: `${SITE_URL}/branches/${encodeURIComponent(b.code)}`,
      lastModified,
      priority: 0.6,
    })
  );

  return [...staticPages, ...servicePages, ...branchPages];
}
