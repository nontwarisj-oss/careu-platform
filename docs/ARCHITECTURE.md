# CareU OPS Platform — Architecture

> **Status:** permanent reference. Every PR must keep this document accurate.
> Drift between code and this doc means one of them is wrong — fix it in the same change.

---

## 1. System overview

CareU OPS is the multi-brand, multi-branch operating system for two related repair businesses operated by the same owner:

| Brand | Business code | Scope |
|---|---|---|
| **Care U** | `care_u` | Clothing alteration (hems, zippers, dry cleaning, embroidery, …) |
| **Ezy Repair** | `ezy_repair` | Shoes / bags / luggage repair |

A single deployment serves both brands and every branch under each. Branches operate independently day-to-day but roll up to the same HQ for finance, pricing, and analytics.

```
┌──────────────────────────────────────────────────────────┐
│                       Browser                             │
│   Next.js App Router (TypeScript + Tailwind, mobile-first)│
└──────────────┬───────────────────────────────┬───────────┘
               │                               │
        cookie│ HMAC session           anon key│ direct DB reads
               ▼                               ▼
   ┌────────────────────┐         ┌──────────────────────┐
   │  /api/auth/*       │         │  Supabase Postgres   │
   │  /api/sync-*       │         │  • orders            │
   │  /api/debug-sheet  │         │  • customers         │
   │  (Node runtime)    │         │  • branches          │
   └────────┬───────────┘         │  • profiles          │
            │                     │  • service_prices    │
            │                     │  • order_audit_log   │
            │                     │  • job_id_sequence   │
            │                     │  • expense_log       │
            │                     └─────┬────────────────┘
            │ service-role JWT          │ anon JWT
            ▼                           ▼
   ┌──────────────────────┐    Row Level Security (selectively on)
   │ Google Sheets API    │
   │ • Front_Desk         │
   │ • Pricing            │
   │ • Expense_Log        │
   │ • Debug              │
   └──────────────────────┘
```

---

## 2. Multi-branch architecture

### 2.1 Branch as a first-class entity

- `public.branches` is the source of truth (`uuid id`, `text code` unique, `text short_code`, `name`, `type`, `brand`, `is_active`).
- `branches.code` is the canonical slug that other tables join against (e.g. `c24-thonburi-market`).
- `branches.short_code` is the human-readable prefix used in Ezy job IDs (e.g. `SLM`, `C24`).
- `lib/brandConfig.ts` holds the **client-side** mirror of the branch list for UI labels / accent colours. The DB is authoritative; brandConfig is allowed to lag by minutes, not days.

### 2.2 Branch isolation rules

| Layer | Rule |
|---|---|
| **UI** | `RouteGuard` + sidebar filter pages by role; branch selector locks to user's branch when `role.allBranches=false`. |
| **Forms** | Order form section 0 hides the branch picker for non-`owner`/`hq_admin` roles. |
| **Database** | RLS policies (next-phase, see [RLS_POLICY.md](./RLS_POLICY.md)) constrain `orders` / `customers` reads to the user's branch. |
| **Audit** | Every cross-branch read by an `owner`/`hq_admin` is auditable via `order_audit_log` + Supabase request logs. |

**Never hardcode a branch.** Always resolve via `useBranch()` (client) or the session cookie + `branches` lookup (server). Hardcoded branch slugs anywhere outside `lib/brandConfig.ts` is a bug.

---

## 3. Franchise-ready strategy

The platform was designed so that today's two branches can grow to N franchises without re-architecture:

| Concern | Strategy |
|---|---|
| Onboarding a new branch | Insert a row in `branches`. Update `lib/brandConfig.ts` to mirror it. No code change otherwise. |
| Onboarding a franchise owner | Their `profiles.role = 'branch_manager'` (or `'owner'` for an entrepreneurial franchisee), `profiles.branch_id = <their branch uuid>`. RLS handles isolation. |
| Per-franchise pricing | `service_prices.branch_id` (nullable) — null means global, set means override. Resolution is "most-specific wins" (see [PRICING_RULES.md](./PRICING_RULES.md)). |
| Per-franchise branding | `brandConfig` per branch (logo, accent gradient, receipt name). |
| Cross-franchise reporting | Owner/HQ roles see all branches; reports honour the branch filter. |

---

## 4. Frontend stack

| Concern | Choice |
|---|---|
| Framework | **Next.js 16 App Router** (Turbopack, TypeScript everywhere) |
| Styling | **TailwindCSS** — utility-first, mobile-first breakpoints |
| State | Lightweight contexts: `LanguageProvider`, `RoleProvider`, `BranchProvider`, `AuthProvider` |
| Data | `@supabase/supabase-js` directly from client components (anon key) for most reads/writes; server-only Node routes for anything requiring a service role |
| Forms | Native controlled inputs; no form library |
| Server runtime | Only the auth + sync route handlers declare `runtime = 'nodejs'`; everything else is the default edge-ready runtime |
| Build | `pnpm build` (`next build`) — must pass on every PR |

**Mobile-first.** Front-desk staff use the platform on a tablet or phone. Every new page must render correctly at 360 px width.

---

## 5. Backend stack

| Concern | Choice |
|---|---|
| Database | **Supabase Postgres** (managed) |
| Auth (live today) | **LINE Login + HMAC-signed cookie** — see [`lib/session.ts`](../lib/session.ts), [`lib/lineLogin.ts`](../lib/lineLogin.ts) |
| Auth (next phase) | Bridge LINE → Supabase Auth so `auth.uid()` is non-null and RLS becomes the real enforcement layer |
| Server functions | Postgres SQL functions for atomicity (`public.generate_ezy_job_id`) |
| Migrations | Plain `.sql` files in `supabase/migrations/`, numbered `YYYYMMDD_*.sql`. Each migration is **idempotent** (`if not exists` / `on conflict do update`). |
| Service role | `SUPABASE_SERVICE_ROLE_KEY` — server-only — bypasses RLS for the auth bridge and admin tasks |
| External | Google Sheets API (service-account JWT, no SDK) — see [GOOGLE_SHEET_SYNC.md](./GOOGLE_SHEET_SYNC.md) |
| Deploy | Vercel |

---

## 6. Auth architecture

```
┌──────────┐  Sign in with LINE   ┌─────────────────────┐
│  Browser ├─────────────────────►│ /api/auth/line/start│
│          │                      └─────────┬───────────┘
│          │  ◄── 302 to LINE OAuth ────────┘
│          │  ◄── 302 back with code ───────┐
│          │                                ▼
│          │                      ┌─────────────────────┐
│          │  Set-Cookie:         │ /api/auth/line/     │
│          │  careu_session ──────│   callback          │
│          │  (HMAC-SHA256)       │ • exchange code     │
│          │                      │ • fetch LINE profile│
│          │                      │ • upsert users +    │
│          │                      │   profiles (admin)  │
│          │                      │ • encode + sign JWT │
│          ◄──────────────────────┴─────────────────────┘
│          │
│          │  every page load:
│          │  fetch /api/auth/me
│          │  AuthProvider hydrates role + branchId
└──────────┘
```

### 6.1 Cookie shape
`careu_session = base64url(payload).base64url(HMAC-SHA256(payload, SESSION_SECRET))`
Payload: `{ uid, sub, role, branchId, name, iat, exp }`. TTL 7 days.

### 6.1b Supabase JWT bridge

After login, `/api/auth/me` mints a **short-lived HS256 JWT** signed with `SUPABASE_JWT_SECRET` — the same secret PostgREST uses to validate session tokens. The browser's supabase client injects it as `Authorization: Bearer …` on every request via a `fetch` interceptor in [`lib/supabase.ts`](../lib/supabase.ts). PostgREST decodes the JWT → `auth.uid()` = `profiles.id` → the RLS policies in `20260522` apply.

- TTL: 8 hours. `AuthProvider` schedules a proactive `/api/auth/me` refresh 5 minutes before expiry.
- No matching `auth.users` row is created. PostgREST only validates the signature; it does not require an existing user row.
- When `SUPABASE_JWT_SECRET` is unset, the JWT comes back null and the client runs as anon — RLS denies orders / customers reads (this is the locked state until the bridge is configured).

### 6.2 Strict vs preview mode

The platform runs in two modes automatically:
- **Preview mode** — `SESSION_SECRET` or any `LINE_LOGIN_*` env var missing. Sidebar role-preview selector is visible; no `/login` redirect. Used for local dev and demos.
- **Strict mode** — all auth env vars set. Unauthenticated users are redirected to `/login`. Role/branch come from the session, not localStorage.

`/api/auth/me` returns `authRequired: boolean` so the client knows which mode it's in.

### 6.3 First user

The very first successful LINE login on a fresh database is bootstrapped as `role='owner'` so the shop owner can set up the platform without a manual `UPDATE`. Subsequent logins default to `role='front_staff'`.

---

## 7. Supabase structure

Single schema: `public`. Authoritative migrations under `supabase/migrations/`:

| Migration | Adds |
|---|---|
| `20260512_orders.sql` | orders, customers core |
| `20260513_intake_extension.sql` | urgent, urgent_fee, notes, branch_id, order_attachments |
| `20260514_smart_order_columns.sql` | subtotal, discount, service_category/_code/_name, quantity, template_text, customer_type, promotion_code |
| `20260515_payment_columns.sql` | payment_status, payment_method, document_type |
| `20260516_rbac_finance.sql` | roles, permissions, users, branch_expenses, cost_estimate, labor_cost, material_cost |
| `20260517_customer_phone_norm.sql` | customers.normalized_phone |
| `20260518_expense_log.sql` | full expense ledger |
| `20260519_pricing_master.sql` | service_prices (versioned) |
| `20260520_auth_audit.sql` | user identity columns, order_audit_log, orders.job_id (initial), system_settings |
| `20260521_enterprise_foundation.sql` | branches, profiles, business_type, due_date, tech, customers extras, job_id_sequence, generate_ezy_job_id, scoped job_id index, RLS on new tables |
| `20260522_auth_bridge_rls.sql` | helper functions `current_user_role()` + `current_user_branch_code()`; strict RLS on orders + customers; admin/branch read policies on profiles |
| `20260523_pricing_engine.sql` | `service_prices` column renames + business_type + sort_order + updated_at trigger; `branch_id` text → uuid FK; scoped unique index; `pricing_audit_logs` + trigger; RLS read-all / admin-write |
| `20260524_technician_foundation.sql` | `technician_profiles` table + RLS; orders `assigned_technician_id` / `assigned_at` / `production_value` / `assignment_notes`; `touch_assignment` trigger; `technician_daily_kpi` view |
| `20260525_payroll_foundation.sql` | `current_user_branch_id()` helper; `expenses` standardised (`created_by_uuid`, `updated_at`, `updated_by`, triggers) + RLS; `payroll_periods` + `technician_payroll_items` tables; `branch_monthly_profit` view; RLS on all new objects |

Every new migration MUST:
1. Be idempotent.
2. Backfill data conservatively (default values that never change semantics on existing rows).
3. Reference upstream migrations only by behavior, never by row id.
4. Disable RLS only with a documented next-phase plan.

---

## 8. Google Sheet integration architecture

Two-way sync where each direction has one owner of truth:

| Direction | Source of truth | Trigger |
|---|---|---|
| **Order → Sheet** (`Front_Desk` tab) | Supabase | Fire-and-forget POST from `SmartOrderForm`; retry button on `/orders/[id]/document` |
| **Pricing → Sheet** (`Pricing` tab) | Supabase | Manual POST from `/pricing` (snapshot on demand) |
| **Sheet → Customers** (`Data_Center` tab) | Sheet | Manual POST from `/customers` "ซิงค์จาก Google Sheet" |
| **Sheet → Expenses** (`Expense_Log` tab) | Sheet | Manual POST from `/expenses` |

All Google calls happen server-side from Node-runtime route handlers in `/app/api/`. Credentials (`GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` / `GOOGLE_SHEET_ID`) are never exposed to the browser. See [GOOGLE_SHEET_SYNC.md](./GOOGLE_SHEET_SYNC.md).

---

## 9. Dashboard architecture

Three-layer separation, as of the dashboard foundation refactor:

```
┌────────────────────────────────────────────────────────────┐
│  app/page.tsx                                              │
│    • Picks the active role-specific view (5 components)    │
│    • Calls fetchDashboardSnapshot on mount + on branch     │
│      or role change                                        │
│    • Passes the resulting orders/expenses/customerCount    │
│      to the dashboard components                           │
└──────────────┬─────────────────────────────────────────────┘
               │
               ▼  (one call instead of inline useEffect)
┌────────────────────────────────────────────────────────────┐
│  lib/dashboardData.ts                                      │
│    • fetchDashboardSnapshot({ branchCode, allBranches })   │
│    • Pulls orders (wide → narrow fallback), expenses,      │
│      customer count                                        │
│    • Applies a belt-and-braces branch filter on top of     │
│      RLS so preview mode still scopes correctly            │
└──────────────┬─────────────────────────────────────────────┘
               │
               ▼  (pure functions, no DB)
┌────────────────────────────────────────────────────────────┐
│  lib/dashboardKpi.ts                                       │
│    • Operational KPIs: sales today / pending / ready-      │
│      for-pickup / overdue / due-soon / labor cost /        │
│      estimated profit / technician workload / expense      │
│      summary / top services                                │
│    • assembleKpis(input) → DashboardKpiBundle              │
│    • Re-exports primitives from lib/analytics.ts so a      │
│      consumer needs one import                             │
└────────────────────────────────────────────────────────────┘
```

Branch isolation runs at three layers (defense in depth):

| Layer | What |
|---|---|
| **UI** | Sidebar branch selector locks for non-admin roles; dashboard shows "ทุกสาขา / All branches" label for admins. |
| **Server (RLS)** | `orders` / `expenses` / `customers` policies from migrations `20260522` + `20260525` scope reads by `current_user_branch_code()`. |
| **Client filter** | `fetchDashboardSnapshot` re-applies the branch filter on the result so preview-mode (no JWT bridge) still works. |

Pages that need fewer KPIs import the individual helpers; pages that need everything call `assembleKpis(snapshot)` and read the bundle. Future per-branch tabs / per-tech widgets just call the same data + KPI layer with a different scope.

### Future scaling
The fetcher signature is the swap point. When daily order volume warrants:
- Replace the direct `supabase.from('orders')` reads with an RPC backed by a materialised view (e.g. `dashboard_daily_snapshot(branch_code, day)`).
- Add `swr`-style caching at the React layer.
- Add scheduled refresh of the materialised view via Supabase Cron.

The KPI layer doesn't change — it stays pure functions over the resulting orders/expenses arrays.

---

## 10. CRM architecture

`public.customers` is the master table.
Aggregation runs **client-side** in `lib/customerStats.ts`:
- Match orders by `customer_id` → exact name → simpleName → phone digits embedded in name.
- Compute `orderCount`, `totalSpent`, `latestDate`, `latestService`.
- Segments: `0–1 = new`, `2–4 = repeat`, `5+ = VIP` (see [PRICING_RULES.md](./PRICING_RULES.md) for downstream perks).

The `total_orders` / `latest_service` / `customer_tier` columns on `customers` exist (migration 20260521) but are not yet maintained by triggers — they're scaffolded for the next phase where heavy reporting moves to materialised columns.

---

## 11. Receipt system architecture

One combined intake-quote-receipt document at `/orders/[id]/document`:
- Branded header with the branch's `accentClass` gradient.
- Customer + service detail + summary.
- Internal-only cost panel (labor / material) — hidden from print.
- Payment block with QR placeholder + status selector.
- Action bar with print / save-as-image / LINE OA send / copy-message / sheet sync.

Two output channels:
1. **Browser print** — `window.print()` with `.printing-receipt` body class.
2. **PNG export** — `html-to-image::toJpeg` on `#careu-document-card`.

LINE OA send route is stubbed at `/api/line/send` waiting on the LINE Messaging API channel.

---

## 12. LINE OA integration preparation

Status: **stubbed**. The route handler at `/app/api/line/send/route.ts` and the client helper `lib/lineOA.ts` are wired but inert until these env vars are set:

```
LINE_CHANNEL_ACCESS_TOKEN
LINE_CHANNEL_SECRET
LINE_OA_ID
```

Future flow:
1. Order created → "Send to LINE OA" button on document page.
2. Server: push a Flex/Text message to the customer's LINE userId (looked up by phone or stored on the customer row).
3. Audit: write `order_audit_log` row with `action='sync_pushed'`, `after_value='line_oa'`.

---

## 13. Security principles

1. **Defense in depth.** UI guards + server route guards + RLS — assume any single layer can fail.
2. **Service-role isolation.** The `SUPABASE_SERVICE_ROLE_KEY` only lives in server route handlers (`lib/supabaseAdmin.ts`). Never imported from a `"use client"` file.
3. **No secrets in the browser.** All `LINE_*`, `GOOGLE_*`, `SESSION_SECRET`, and service-role keys are server-only.
4. **Cookies are HttpOnly + SameSite=Lax + Secure-in-prod.** Session cookie cannot be read by JS.
5. **Audit everything financial.** `order_audit_log` writes on `created`, `status_changed`, `payment_changed`, `cost_updated`, `sync_pushed`.
6. **RLS is the real enforcement layer.** Frontend hiding is a UX courtesy, not security. See [RLS_POLICY.md](./RLS_POLICY.md).

---

## 14. Scaling principles

| Dimension | Strategy |
|---|---|
| **Read throughput** | Anon client reads with proper indexes — `orders (branch_id, created_at)`, `customers (normalized_phone)`, `service_prices (service_code, effective_from)`. |
| **Write throughput** | Single writes per user action; no batch writes from the browser. Sheet sync is fire-and-forget so order create is never blocked. |
| **Job ID contention** | Concurrency-safe via Postgres `on conflict do update returning` in `generate_ezy_job_id`. |
| **Branch count growth** | All branch-related logic is data-driven (branches table). No code change to onboard a new branch. |
| **Schema growth** | Additive migrations only. Drops require an explicit deprecation cycle (rename → backfill → remove in next migration). |

---

## 15. Production-safe development rules

These are non-negotiable. PRs that violate them must be sent back.

1. **NEVER hardcode a branch.** Always go through `useBranch()` or a `branches` query.
2. **NEVER disable RLS permanently.** If a migration enables RLS on a table, it stays on. Temporary `using (true)` policies must ship with a TODO comment naming the next migration.
3. **Preserve existing workflow.** A migration that breaks an existing manual sheet or staff habit must come with a one-line fix to either side. Don't surprise the front-desk.
4. **Mobile-first.** Every new page renders correctly at 360 px. Test in DevTools at iPhone SE width before merging.
5. **Staff usability first.** A pretty dashboard that takes 4 taps to record an order is a worse product than an ugly one that takes 1.
6. **Automation preferred.** If a task can be a button, it's a button. If a button can be a hook, it's a hook.
7. **Migrations are forever.** Once committed, never edit a migration file — write a new one.
8. **Every schema change has a doc update.** Drift between code and docs is treated like a failing test.

---

## 16. File map (quick reference)

```
app/
├── api/
│   ├── auth/{line/start,line/callback,logout,me}/route.ts
│   ├── debug-sheet/route.ts            ← Google Sheets diagnostics
│   ├── sync-customers/route.ts         ← Sheet → DB (Data_Center)
│   ├── sync-expenses/route.ts          ← Sheet → DB (Expense_Log)
│   ├── sync-order-to-sheet/route.ts    ← DB → Sheet (Front_Desk)
│   └── sync-pricing-to-sheet/route.ts  ← DB → Sheet (Pricing snapshot)
├── customers/page.tsx
├── expenses/page.tsx
├── intake/page.tsx                     ← walk-in counterpart of /orders
├── invoices/page.tsx
├── login/page.tsx
├── orders/page.tsx
├── orders/[id]/document/page.tsx       ← combined receipt
├── pricing/page.tsx                    ← pricing master (manager+)
├── reports/{branches,customers,expenses,profit,revenue}/page.tsx
└── layout.tsx                          ← Language→Role→Branch→Auth providers

components/
├── SmartOrderForm.tsx                  ← Care U + Ezy intake
├── RouteGuard.tsx                      ← per-page role gate
├── Sidebar.tsx                         ← nav + auth + branch selector
├── Modal.tsx, Table.tsx, StatCard.tsx
└── dashboard/, charts/, reports/

lib/
├── authContext.tsx, roleContext.tsx, branchContext.tsx, languageContext.tsx
├── session.ts        ← HMAC cookie codec
├── lineLogin.ts      ← LINE OAuth client
├── supabaseAdmin.ts  ← service-role client (server-only)
├── supabaseJwt.ts    ← HS256 bridge JWT minter (server-only)
├── supabaseAuth.ts   ← getCurrentUser/Profile + requireRole/BranchAccess (server-only)
├── supabase.ts       ← anon client with bridge-JWT fetch interceptor
├── roles.ts          ← 5-role taxonomy + legacy mapping
├── permissions.ts    ← capability helpers
├── orderCreate.ts    ← createSmartOrder with progressive schema fallback
├── pricing.ts        ← hardcoded SERVICES (fallback only)
├── pricingDb.ts      ← service_prices reader with hardcoded fallback
├── customerStats.ts  ← client-side CRM aggregation
├── googleSheets.ts   ← server-only Sheets append helper
├── jobId.ts          ← Care U manual id normalize/validate
├── phone.ts          ← Thai phone canonicalisation
├── brandConfig.ts    ← branch UI metadata (mirror of branches table)
├── pricing.ts        ← legacy hardcoded catalog
├── technicianService.ts ← skill catalog + recommendTechnician
├── technicianKpi.ts  ← daily/monthly KPI + ranking helpers
├── payrollService.ts ← production target, performance ratio, estimated payroll, branch labor cost, monthly profit fetch
├── dashboardData.ts  ← single fetcher for orders + expenses + customer count (role-aware branch scope)
└── dashboardKpi.ts   ← operational KPI helpers + assembleKpis bundle

supabase/migrations/
└── 20260512..20260525 (see §7)
```

---

**Last updated:** 2026-05-13 (commit 4805d3b)
