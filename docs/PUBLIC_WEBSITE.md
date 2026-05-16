# CareU OPS Platform — Public Website Foundation

> **Status:** foundation only. The customer-facing website ships in this phase; marketing automation, customer login, broadcast, and AI quotation are deliberately deferred.

---

## 1. Why two surfaces

The platform now has two distinct UX surfaces sharing one Next.js deployment + one database:

| Surface | URL prefix | Auth | Audience |
|---|---|---|---|
| **OPS** | `/`, `/orders`, `/customers`, `/admin/*`, `/reports/*`, `/expenses`, `/invoices`, `/intake`, `/pricing` | LINE login + JWT bridge → RLS | Owner / HQ / branch_manager / front_staff / technician |
| **Public website** | `/website`, `/branches`, `/services`, `/track`, `/quote`, `/about`, `/contact` | Anonymous (no login) | Customers and prospects |

The two surfaces are wired into the **same database** — public reads use the service-role admin client in tightly-scoped server routes; public writes use anon RLS policies for the narrow case of quote submissions.

`app/(public)/layout.tsx` is the route group that omits the OPS sidebar and ships its own header / footer. `lib/authContext.tsx` whitelists `PUBLIC_PREFIXES` so anonymous visitors don't get redirected to `/login`.

---

## 2. Public routes

| Route | Source | Purpose |
|---|---|---|
| `/website` | `app/(public)/website/page.tsx` | Marketing landing — feature cards + CTA buttons. |
| `/branches` | `app/(public)/branches/page.tsx` | All active branches grid (server-rendered from `public.branches`). |
| `/branches/[code]` | `app/(public)/branches/[branchCode]/page.tsx` | Single-branch detail with brand-aware theme; CTA links pre-fill the branch on `/quote`. |
| `/services` | `app/(public)/services/page.tsx` | Catalog grouped by `SERVICE_CATEGORIES` — read from `public.service_prices`. |
| `/track` | `app/(public)/track/page.tsx` | Customer enters Job ID + phone; calls `/api/public/track`. |
| `/quote` | `app/(public)/quote/page.tsx` | Quote-request form; submits to `/api/public/quote`. |
| `/about` | `app/(public)/about/page.tsx` | Static brand story. |
| `/contact` | `app/(public)/contact/page.tsx` | Contact options + links to /quote, /track, /branches. |

Sitemap at `app/sitemap.ts`, robots at `app/robots.ts`. Sitemap pulls branch URLs dynamically from `public.branches`.

---

## 3. Public API routes

| Route | Method | Auth | Rate limit | Purpose |
|---|---|---|---|---|
| `/api/public/branches-list` | GET | none | none (read-only public data) | Active-branches dropdown for /quote |
| `/api/public/track` | POST | none (phone + jobId is the auth factor) | 10/min/IP + 5/min/IP-jobId | Read narrow order subset |
| `/api/public/quote` | POST | none | 5/hour/IP | Insert into `quote_requests` + log `customer_activity` |

All three run on the Node runtime and call `getSupabaseAdmin()` server-side. RLS doesn't apply through the admin client, so each route is **hand-built to return only safe fields**.

### 3.1 `/track` security contract

What `/api/public/track` returns:
- `jobId` (echoed back)
- `branchLabel` — branch's display name only, never the slug
- `status` + `statusLabel` (Thai)
- `paymentStatus` + `paymentLabel`
- `dueDate`, `createdAt`
- `readyForPickup` boolean

What it deliberately does NOT return:
- `id` (full uuid)
- price, labor cost, material cost, discount, urgent fee
- customer name (the caller already knows it)
- technician id / name
- notes, template_text (may carry private staff notes)
- branch slug or any internal id

The phone normalisation + verification step makes the route safe to expose at the customer's discretion — a wrong phone never returns data, identical response shape to an unknown jobId so enumeration is useless.

### 3.2 `/quote` integrity contract

- Phone is normalised before insert (`lib/phone.ts::normalizePhone`).
- Branch code is validated against active branches when present (prevents inserts pointing at deactivated branches).
- Notes capped at 2000 chars; photos array capped at 10 entries with each URL ≤ 500 chars.
- One `customer_activity` row is also written with `kind: 'quote_submitted'`. `customer_id` stays NULL until an admin pairs the request with a real customer at triage time.

---

## 4. Theme system

[`lib/publicTheme.ts`](../lib/publicTheme.ts) is the single source of truth for brand colours, taglines, and microcopy on every public page.

Two layers:
1. `BRAND_THEMES` constants — Care U + Ezy Repair defaults.
2. Per-branch override pulled from `public.branches` (the same UI-metadata columns the OPS layer reads via `lib/branchContext.tsx`).

`themeForBranch(branch)` merges a branch row over the brand default. Per-field fallback so a partial DB row never renders an empty header.

A new brand (or franchise re-skin) means: add a `BRAND_THEMES` entry, set `branches.brand` on the new row, optionally override `accent_class` / `logo_path` / `tagline`. No code change needed in public pages.

---

## 5. SEO

Each public page exports `metadata`:
- title + description in Thai (the primary audience).
- OpenGraph defaults from the layout (`siteName: "Care U OPS"`, `locale: "th_TH"`).
- `robots: { index: true, follow: true }`.

Dynamic branch pages produce per-branch metadata via `generateMetadata({ params })` — title is the branch's `short_label`, description is the tagline + address.

Sitemap includes every static page + one URL per active branch. `robots.txt` blocks `/api`, `/admin`, `/orders`, `/customers`, `/intake`, `/invoices`, `/expenses`, `/reports`, `/pricing`, `/login`.

---

## 6. Branch isolation

Public routes deliberately don't surface branch-scoped operator data:

| Surface | Branch isolation mechanism |
|---|---|
| `/branches`, `/branches/[code]` | Reads only `public.branches` (no per-customer / per-order data). Public table. |
| `/services` | Reads only `public.service_prices` — global pricing or branch-pinned overrides (the public page shows the global catalog only). |
| `/track` | Phone match required; route returns branch label not slug. |
| `/quote` | Anonymous insert into `quote_requests`. Admin triage path pairs with a real customer in `/admin/recovery` (future) or a dedicated triage UI. |

No public page ever joins `public.orders` or `public.customers` without auth gating.

---

## 7. Rate limiting

`lib/rateLimit.ts` is an in-memory token bucket. Two namespaces per public endpoint where appropriate:

| Endpoint | Limits |
|---|---|
| `/api/public/track` | 10 requests / minute / IP, then 5 / minute / (IP + jobId) pair |
| `/api/public/quote` | 5 requests / hour / IP |
| `/api/public/branches-list` | none (cached on the client) |

Not cluster-aware — each cold-start gets a fresh map. A real attacker would hit Vercel's underlying anti-abuse first; the per-request limiter is enough for casual abuse. A Redis / Upstash store is the obvious next-phase swap.

---

## 8. Known limitations

- **No image uploads** — `/quote` accepts a textarea of image URLs only. Supabase Storage integration is a future phase.
- **No customer login / portal** — `/track` requires Job ID + phone every visit; there's no session state for customers yet.
- **No map / hours per branch** — `/branches/[code]` shows the address as text and notes that map + hours arrive later.
- **Rate limit is per-process** — cold-start resets the bucket. Acceptable foundation.
- **`SERVICE_CATEGORIES` lives in code** — `/services` reads it via `lib/pricing.ts`. A DB-mirror is a small future migration.
- **No admin triage UI for `quote_requests` yet** — admins read the table directly today. A future `/admin/quotes` page surfaces it.
- **No customer-facing language switcher** — the public site is Thai-only for now. The existing LanguageProvider is mounted but not exposed in the public layout.
- **OG images are Latin-only** — generated by `next/og` (Phase 27C). The default `next/og` font has no Thai glyphs, so the cards use brand labels, branch codes, and English service titles. A bundled Thai font would let the cards carry Thai copy.

---

## Phase 27B — public website maturity

Migration `20260552` adds four nullable columns — `branches.operating_hours` (jsonb) + `branches.promo_banner`, and `quote_requests.urgency` + `quote_requests.fulfilment_preference`. Additive only.

1. **Homepage** — `/website` rebuilt into sections: hero, service categories (linking the new detail pages), a 4-step process flow, a live branch finder (reads `branches` — no hardcoded list), an FAQ accordion, and a LINE CTA. `FAQPage` JSON-LD emitted.
2. **Branch pages** — `/branches/[branchCode]` gains operating hours (graceful when `operating_hours` is NULL), a Google-Maps CTA derived from `address`, a LINE CTA, a supported-services grid, an optional `promo_banner`, and `LocalBusiness` JSON-LD.
3. **Service pages** — new `/services/[slug]` (4 SEO pages: jeans-hemming, zipper-replacement, suit-alteration, dress-adjustment). Editorial content from [`lib/serviceContent.ts`](../lib/serviceContent.ts) — process, turnaround, price guidance, FAQ. `Service` + `FAQPage` JSON-LD. `/services` index links them.
4. **Quote wizard** — `/quote` rebuilt as a 4-step wizard (service → photos → details → contact + review) with a step indicator. New fields: urgency + fulfilment preference. LINE continuation on success.
5. **Anonymous draft-save** — the wizard auto-saves to `localStorage` (`careu_quote_draft_v1`); a returning visitor sees a "resume / start over" banner. Cleared on successful submit.
6. **Public upload safety** — [`components/PublicQuoteUploader`](../components/PublicQuoteUploader.tsx): type + 8 MB validation, client-side compression ([`lib/imageCompress.ts`](../lib/imageCompress.ts) — canvas → JPEG; HEIC passes through), signed upload via `/api/public/upload-url` → `uploadToSignedUrl`, a per-file queue with progress + retry. Uploaded storage paths land in `quote_requests.photos`.
7. **SEO** — `app/sitemap.ts` extended with `/services/[slug]`; `generateMetadata` + OpenGraph on all new pages; FAQ / Service / LocalBusiness JSON-LD.

---

## Phase 27D — franchise-safe public layer

Migration `20260553` adds five additive nullable `branches` columns: `manual_status`, `holiday_dates` (jsonb), `map_url`, `line_url`, `hero_image_path`.

1. **Operator settings UI** — `/admin/settings/branches` (owner/HQ) edits every branch's public fields — operating hours, promo banner, open/closed override, holiday dates, map + LINE links, hero image — with a live status preview. `GET/POST /api/admin/settings/branch-public`; audited to `cron_heartbeat_logs`. No code edit needed to change a branch's public face.
2. **Dynamic open/closed** — [`lib/branchPublicStatus.ts`](../lib/branchPublicStatus.ts)`::computeBranchStatus` resolves: manual override → holiday → today's hours vs Bangkok time → `unknown`. Surfaced as a badge on the branch page hero, the homepage branch finder, and the quote wizard's branch selector (`/api/public/branches-list` now returns `status`).
3. **Per-branch branding** — the branch page uses `hero_image_path` (background image with overlay), `line_url` (per-branch LINE CTA), and `map_url` (explicit map link, else derived from address).
4. **Fallback** — every new column is nullable; pages degrade gracefully (no hours → "ติดต่อสาขา"; no hero → accent gradient; no line_url → global env). No hardcoded branches anywhere — all lists read the DB.
5. **Public smoke test** — `/admin/system/smoke-test` gains a "Public website" category: branch-page count, operating-hours coverage, quote pipeline, service-page count, `NEXT_PUBLIC_SITE_URL` / `NEXT_PUBLIC_BASE_URL` / `NEXT_PUBLIC_LINE_OA_URL`.

---

## Phase 27C — SEO & performance deep pass

No migration — additive code only.

1. **SEO core** — [`lib/publicSeo.ts`](../lib/publicSeo.ts) centralises `SITE_URL`, `absoluteUrl()`, `canonical()`, and `breadcrumbJsonLd()`. The public layout sets `metadataBase`; every public page now advertises a `<link rel="canonical">` and an absolute `og:url`. `/quote` and `/track` (client components) gained thin `layout.tsx` files purely to carry their metadata.
2. **Structured data** — homepage adds `Organization` + `WebSite` JSON-LD (alongside the existing `FAQPage`); branch pages add `BreadcrumbList` and an enriched `LocalBusiness` (`url`, `image`, `openingHoursSpecification` derived from `operating_hours`); service pages add `BreadcrumbList`.
3. **Dynamic OG images** — `next/og` `ImageResponse` routes: a default `(public)/opengraph-image`, a per-service card (`/services/[slug]`, prerendered), and a per-branch card (`/branches/[branchCode]`, on-demand). Shared renderer [`lib/ogTemplate.tsx`](../lib/ogTemplate.tsx). Latin-only text — see Known limitations.
4. **Performance** — `loading.tsx` Suspense skeletons on every public segment that does a DB read (`/website`, `/branches`, `/branches/[code]`, `/services`, `/services/[slug]`), all sharing [`components/PublicSkeleton.tsx`](../components/PublicSkeleton.tsx). The branch hero `<img>` carries `decoding="async"` + `fetchPriority="high"`.
5. **Accessibility** — a skip-to-content link + `<main id="main-content">` in the public layout; a global `:focus-visible` ring in `globals.css`; explicit focus rings on the public nav; `aria-label` / `aria-current` on the quote wizard step indicator.
6. **Mobile UX** — the quote wizard's nav bar is `sticky bottom-0` on mobile so the primary action stays reachable; `sm:static` on larger screens.
7. **404** — `(public)/not-found.tsx` keeps the public chrome for missing branch/service slugs (previously fell through to the OPS 404).

**Last updated:** 2026-05-16 (phase 27C — SEO & performance deep pass)
