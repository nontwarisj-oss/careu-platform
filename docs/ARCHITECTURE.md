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
| `20260526_operational_hardening.sql` | `sync_failures` durable queue + RLS; `expense_audit_log` + trigger; `order_audit_log.action` enum extended (+ assigned, receipt_regenerated, sync_failed); `orders` NOT VALID CHECK constraints (status / payment_status / quantity / non-negative numerics); `validate_order_assignment` trigger (rejects inactive-tech + cross-branch); search indexes (orders.customer_name lower, orders(branch_id,status,created_at desc), pg_trgm GIN on customers.name + normalized_name) |
| `20260527_line_oa_foundation.sql` | `customer_line_links` (line_user_id ↔ customer_id + per-kind prefs + consent); `line_message_log` (every send attempt); `branch_line_configs` (per-branch channel token, env fallback); RLS on all three |
| `20260528_recovery_foundation.sql` | `sync_failures.kind` CHECK extended with `'line_send'` + `'receipt_rebuild'`; `sync_failures_branch_read` RLS policy so branch_manager sees own-branch failures in `/admin/recovery` |
| `20260529_cron_and_line_follow.sql` | `worker_runs` heartbeat table (one row per retry-tick — cron or manual); `line_follow_events` audit table (every LINE webhook event, signature_verified flag, consented_at for verified follows); admin-read RLS on both |
| `20260530_customer_linker_and_reconcile.sql` | `customer_line_links.ignored_at` + `ignored_by` for admin triage; `sync_failures.kind` CHECK extended with `reconcile_missing_sheet` + `reconcile_duplicate_sheet` + `reconcile_orphan_link`; new `reconcile_runs` heartbeat table |
| `20260531_management_intelligence.sql` | `public.customers.lifetime_spend` + `last_visit_at` + `primary_branch_id` insight columns; materialised view `public.dashboard_daily_snapshot` (branch_code × work_date with revenue / counts / fees); `refresh_dashboard_daily_snapshot()` SECURITY DEFINER wrapper (concurrent-safe with non-concurrent fallback for first refresh) |
| `20260532_bonus_engine_columns.sql` | `technician_payroll_items.bonus_suggested` + `bonus_rule_version` audit columns. Bonus engine writes both at save time so historical override deviations are queryable. |
| `20260533_brandconfig_db_mirror.sql` | `public.branches` gains UI-metadata columns: `short_label`, `short_name`, `receipt_name`, `tagline`, `address`, `phone`, `logo_path`, `accent_class`. Seeded rows updated to mirror `lib/brandConfig.ts`. branchContext reads from DB with hardcoded list as fallback. |
| `20260534_public_website_and_crm_foundation.sql` | New tables: `quote_requests` (inbox for public /quote submissions, anon INSERT allowed), `customer_tags`, `customer_notes`, `customer_activity`, `customer_channels` — CRM scaffolding for future segmentation / VIP / LINE CRM. RLS on every table; branch isolation joins via customer.branch_id where the row lacks one. |

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

Three-layer separation (mirrors the dashboard refactor):

```
┌────────────────────────────────────────────────────────────┐
│  app/orders/[id]/document/page.tsx                         │
│    • Page chrome: action bar (PrintModeSelector),          │
│      cost panel, payment selector, sync pill               │
│    • Reads orders / customers / labor + material costs     │
│    • Picks the right template based on print mode          │
└──────────────┬─────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────┐
│  lib/receiptData.ts        (pure data builders)            │
│    • buildReceiptData(input) → ReceiptData                 │
│    • buildReceiptItems / buildReceiptTotals /              │
│      buildPaymentSummary                                   │
│    • Server-safe (no React imports)                        │
└──────────────┬─────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────┐
│  components/receipt/                                       │
│    • ReceiptA4.tsx       — full-page brand card            │
│    • ReceiptThermal.tsx  — 80mm monospace strip            │
│    • ReceiptMobile.tsx   — single-column phone layout      │
│    • ReceiptCommon.tsx   — status badges, QR placeholder   │
│    • PrintModeSelector.tsx — pill toggle                   │
└──────────────┬─────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────┐
│  lib/printService.ts                                       │
│    • printReceipt({ mode })   — browser print + body class │
│    • saveReceiptAsImage(...)  — html-to-image::toJpeg      │
│    • generateReceiptPdf(...)  — stub for future PDF        │
│    • sendReceiptViaLine(...)  — stub for LINE image push   │
└────────────────────────────────────────────────────────────┘
```

### Print modes
| Mode | Template | Page size | Use |
|---|---|---|---|
| `a4` | `ReceiptA4` | A4 (12mm margin) | Counter print, file copy, customer hand-off |
| `thermal` | `ReceiptThermal` | 80mm × auto (4mm margin) | ESC/POS receipt printer |
| `mobile` | `ReceiptMobile` | A4 (preview) | Tablet display, customer phone preview, future LINE image |

The printer page-size swap happens in [`app/globals.css`](../app/globals.css) via `body.printing-thermal @page { size: 80mm auto; }`. `lib/printService.ts` adds/removes the body class around `window.print()`.

### CSS rules
- `body.printing-receipt` → hides everything except `.print-this` (the receipt root).
- `body.printing-thermal` → swaps the @page size to 80mm and forces monospace + black ink for thermal.
- All `print:hidden` Tailwind classes on internal controls (cost panel, payment selector, sync pill, action bar) are honoured.

### Future delivery channels
- PDF export — `generateReceiptPdf(receipt)` stub today. Implementation: render `ReceiptA4` through a headless browser server-side or via a PDF library (jsPDF / pdf-lib). The signature stays stable so the action-bar button can wire it up.
- LINE OA image — `sendReceiptViaLine(receipt)` stub. Implementation: `saveReceiptAsImage` first, then POST the resulting binary to `/api/line/send` once the LINE channel is configured.
- Customer history — `lib/receiptData.ts::buildReceiptData` is purely a function of the order row; reading historical orders + rendering with the same template is a "for each order" loop. No changes needed.

---

## 12. LINE OA integration (MVP)

Status: **MVP foundation live** as of `20260527_line_oa_foundation.sql`. Four message kinds wired end-to-end. Customer-facing webhook (LINE follow flow that populates `customer_line_links`) is the next phase — until it lands, admins seed links via SQL or the upcoming `/admin/customer-line` UI.

### 12.1 Layered architecture

```
┌────────────────────────────────────────────────────────────┐
│  Browser: /orders/[id]/document or /admin/* (future)       │
│    • sendLineMessage(kind, orderId)   (typed)              │
│    • sendToLineOA(orderId, message)   (legacy free-form)   │
└──────────────┬─────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────┐
│  POST /api/line/send                                       │
│    • requireRole(['owner','hq_admin','branch_manager',     │
│                   'front_staff'])                          │
│    • Returns 200 always; { ok, status, reason } shape      │
└──────────────┬─────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────┐
│  lib/lineDelivery.ts          (orchestrator)               │
│    sendOrderCreatedMessage / sendOrderReadyMessage /       │
│    sendPickupReminderMessage / sendReceiptMessage          │
│    • Loads order + customer + branch via service role      │
│    • Resolves customer LINE link + prefs                   │
│    • Resolves channel config (DB → env fallback)           │
│    • Builds text via lib/lineMessageBuilders               │
│    • Pushes via lib/lineMessaging.pushTextMessage          │
│    • Writes one row to line_message_log regardless         │
│      of outcome (sent / failed / skipped)                  │
│    • Failures also reach lib/syncFailures.logSyncFailure   │
└──────┬──────────┬──────────────────┬───────────────────────┘
       ▼          ▼                  ▼
   ┌─────────┐ ┌──────────┐ ┌──────────────────────┐
   │ Builder │ │  Config  │ │  Messaging client    │
   │ (pure)  │ │ resolver │ │  (LINE push API)     │
   └─────────┘ └──────────┘ └──────────────────────┘
```

### 12.2 Data model

| Table | Purpose | Writes |
|---|---|---|
| `public.customer_line_links` | Customer ↔ LINE user mapping + per-kind opt-in prefs + consent / unsubscribe timestamps | Admin / future follow-webhook |
| `public.line_message_log` | Every send attempt (sent / failed / skipped). Branch-tagged + role-scoped RLS | `lib/lineDelivery.ts` only |
| `public.branch_line_configs` | Per-branch channel access token + auto-send toggles. Tokens are service-role-only-read | Admin via SQL until a future UI |

### 12.3 Channel resolution
`lib/lineConfig.ts::resolveLineChannelConfig(branchUuid)`:
1. If the branch has a `branch_line_configs` row with a non-null `channel_access_token` → use that.
2. Otherwise fall back to env vars (`LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` / `LINE_OA_ID`).
3. If neither → returns null → orchestrator records `status='skipped'` with reason.

This makes the platform franchise-ready: a new franchise plugs in their own LINE OA by inserting one row; until they do, they share the HQ default channel.

### 12.4 Failure handling
- LINE failure NEVER blocks the calling flow. `/api/line/send` always returns 200; the UI inspects `result.ok`.
- Every attempt — including skips — writes a row to `line_message_log` so admins can see "why didn't this customer get a message?".
- Push HTTP failures also reach `lib/syncFailures.ts::logSyncFailure`, which double-writes to `public.sync_failures` for the future retry worker.

### 12.5 Permissions
- Trigger send: `owner`, `hq_admin`, `branch_manager`, `front_staff`. `technician` cannot.
- Read `line_message_log`: `owner` / `hq_admin` see all; `branch_manager` sees own-branch rows; everyone else denied.
- Read `customer_line_links`: `owner` / `hq_admin` full; `branch_manager` / `front_staff` can read links for customers in their branch; everyone else denied.
- `branch_line_configs.channel_access_token` is never readable by any authenticated client — service-role only.

### 12.6 Future expansion path
| Step | What |
|---|---|
| LINE follow webhook | Customer scans the OA QR; server captures `line_user_id`; new row in `customer_line_links` with `consented_at = now()`. |
| Auto-send | Flip `branch_line_configs.auto_send_*` flags; the existing orchestrator is called from the order-create / status-change flow instead of the manual button. |
| Image / Flex receipt | Replace `pushTextMessage` with a Flex Message variant in `lib/lineMessaging.ts`; reuse `lib/printService.saveReceiptAsImage` to host the JPG and link it. |
| Broadcast / segmentation | Out of MVP scope. New `line_broadcast_jobs` table reads `customer_line_links` with a segment filter. |

### 12.7 Env vars
```
LINE_CHANNEL_ACCESS_TOKEN  # global / HQ-default OA push token
LINE_CHANNEL_SECRET        # webhook signature verify (future)
LINE_OA_ID                 # friend / Basic ID for deep links
```
Per-branch overrides go in `public.branch_line_configs` and take precedence.

---

## 12b. Operational hardening (post-`20260526`)

Three concerns ship together because they all defend the same surface — "the platform must not lose data under operator error or network failure":

### 12b.1 Audit strategy
| Domain | Table | Writer | Triggered by |
|---|---|---|---|
| Pricing | `public.pricing_audit_logs` | DB trigger (SECURITY DEFINER) | INSERT / UPDATE / DELETE on `service_prices` |
| Expense | `public.expense_audit_log` | DB trigger (SECURITY DEFINER) | INSERT / UPDATE / DELETE on `expenses` |
| Order | `public.order_audit_log` | App via `lib/auditService.recordAudit({ domain: 'order', … })` or direct insert | order create / status change / payment change / cost edit / assignment / receipt regen / sync push or fail |
| Auth (future) | reserved | reserved | future Supabase Auth events |

Read access is owner / hq_admin only on every audit table (`*_admin_read` policies). No client can DELETE / UPDATE an audit row — append-only by policy.

### 12b.2 Failure handling philosophy
1. **Critical user action succeeds before secondary effects.** Order create persists to `public.orders` first; sync to Google Sheet is fire-and-forget. A sync outage NEVER blocks the staff workflow.
2. **Failures are durable + visible.** `logSyncFailure` in [`lib/syncFailures.ts`](../lib/syncFailures.ts) writes to BOTH the function log AND `public.sync_failures` (when the service role is configured). The DB queue is the basis for a future cron retry job.
3. **Recovery has one entry point.** [`lib/recoveryService.ts`](../lib/recoveryService.ts) exposes `listFailedSyncs`, `markSyncResolved`, `resyncOrderToSheet`, `rebuildReceiptData`. A future `/admin/recovery` page imports this module and drives all four.
4. **Validation is layered.** UI validation in [`lib/validation.ts`](../lib/validation.ts) for friendly errors. App-layer re-validation in service helpers. DB CHECK constraints + triggers as the last line of defence — they always reject invalid writes regardless of how they got there.

### 12b.3 Operational status standardisation
Status fields now have CHECK constraints (NOT VALID so legacy rows are exempt). Canonical values:

| Field | Allowed values |
|---|---|
| `orders.status` | `pending`, `in-progress`, `completed`, `ready-for-pickup`, `cancelled` |
| `orders.payment_status` | `unpaid`, `deposit`, `paid` |
| `orders.quantity` | NULL or `>= 1` |
| `orders.price` / `urgent_fee` / `discount` | `>= 0` (price NOT NULL) |
| `service_prices.business_type` | `care_u`, `ezy_repair` |
| `service_prices.pricing_type` | `fixed`, `estimate_required` |
| `payroll_periods.status` | `open`, `finalized`, `paid`, `cancelled` |
| `sync_failures.status` | `pending`, `retrying`, `resolved`, `dead` |

### 12b.4 Job ID hardening (verification)
The job_id contract is already concurrency-safe (see [JOB_ID_RULES.md](./JOB_ID_RULES.md)):
- Partial unique index `orders_job_id_scoped_idx (branch_id, business_type, job_id) WHERE job_id IS NOT NULL` is the atomic gatekeeper.
- Care U manual ids: app pre-checks, DB index makes the insert the source of truth. Race winner is whichever transaction lands first.
- Ezy Repair auto ids: `generate_ezy_job_id(branch)` is an atomic upsert on `job_id_sequence`. Daily reset is implicit in the `for_date` PK column.

No schema change required in `20260526`. Hardening here is documentation + the new app-side `validateOrderInput` that rejects malformed manual ids before submit.

### 12b.5 Inactive-tech / cross-branch trigger
`public.validate_order_assignment()` runs BEFORE INSERT OR UPDATE OF (assigned_technician_id, branch_id) on `public.orders`. Rejects:
- Assigning a non-existent technician.
- Assigning an inactive technician.
- Assigning a technician whose `branch_id` (uuid → branches.code via join) doesn't match the order's `branch_id` (text slug).

The trigger uses `raise exception … using errcode='check_violation'` so the error surfaces as a Postgres CHECK violation to PostgREST clients — friendly to the supabase-js error handler.

## 12d. Operational recovery foundation (post-`20260528`)

> Status: **foundation live**. The `/admin/recovery` UI is the single operator surface for failure queues. A retry worker / cron is **not** built yet — by design.

### 12d.1 What ships

```
┌────────────────────────────────────────────────────────────┐
│  app/admin/recovery/page.tsx                               │
│    • Tabs: Sync failures / LINE delivery / Receipt rebuild │
│    • Filters: status / kind / branch (admin) / refresh     │
│    • Inspect modal renders the raw JSON                    │
│    • Per-row actions: Retry, Resolve, Resend, Inspect      │
└──────────────┬─────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────┐
│  lib/recoveryService.ts          (single import surface)   │
│    • listFailedSyncs(filter)                               │
│    • listLineMessageLog(filter)        — NEW this phase    │
│    • resyncOrderToSheet(orderId)                           │
│    • resendLineMessage(orderId, kind)  — NEW this phase    │
│    • resolveSyncFailure(failureId)     — NEW this phase    │
│    • rebuildReceiptData(orderId)                           │
│    • rebuildKpiSummaries()             — still a stub      │
└──────────────┬─────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────┐
│  POST /api/admin/recovery/resolve                          │
│    • requireRole(owner / hq_admin / branch_manager)        │
│    • Loads sync_failures row via admin client              │
│    • requireBranchAccess(row.branch_id) for managers       │
│    • Idempotent: short-circuits on status='resolved'       │
│    • Writes payload.resolvedBy / resolvedAt / note         │
└────────────────────────────────────────────────────────────┘
```

The browser singleton supabase client reads `sync_failures` + `line_message_log` directly; RLS on those tables produces a branch-scoped view for the manager.

### 12d.2 Migration `20260528_recovery_foundation.sql`

Two operational adjustments:

1. **Extend `sync_failures.kind` CHECK** to add `'line_send'` and `'receipt_rebuild'`. Fixes the misclassification noted in [TESTING_REPORT.md](./TESTING_REPORT.md) Bug #6 — LINE pushes now log under their own kind instead of `'order_to_sheet'`. The orchestrator in [`lib/lineDelivery.ts`](../lib/lineDelivery.ts) was updated to write the new kind in the same commit.
2. **Add `sync_failures_branch_read` policy** so a branch_manager sees their own branch's failures. Combined with the existing `sync_failures_admin_read`, branch isolation flows through RLS for the read path.

### 12d.3 Retry safety contract

| Concern | Mitigation |
|---|---|
| Double-click a retry button | UI tracks `retrying: Set<rowId>`; button disables for the in-flight request. |
| Resolve clicked twice | Server short-circuits on `status='resolved'`, returns `ok: true, alreadyResolved: true`. |
| Re-sync writes a duplicate Sheet row | Server route always appends — accepted today; future enhancement could dedupe by `target_id` in the sheet column A. |
| Re-send LINE duplicates a message | Append-only: each send writes a new `line_message_log` row. Customer might receive a duplicate — that is the intended trade-off for "the customer didn't get the first one". |
| Cross-branch retry | `requireBranchAccess` re-checks in `/api/sync-order-to-sheet`, `/api/line/send`, and `/api/admin/recovery/resolve`. |
| Service-role unset | Resolve returns 503 with a clear reason; read paths still work via RLS. |

### 12d.4 Retry worker (post-2026-05-14)

The worker ships **as a library + manual trigger**. Cron is intentionally not wired this phase — when a scheduler is added later it calls the same library.

```
┌────────────────────────────────────────────────────────────┐
│  POST /api/admin/recovery/run-worker                       │
│    • requireRole(owner / hq_admin / branch_manager)        │
│    • branch_manager: branchCode FORCED to profile.branch   │
│    • owner / hq_admin: free branchCode (incl. null = all)  │
└──────────────┬─────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────┐
│  lib/retryWorker.ts::runRetryTick(opts)                    │
│    • SELECT … FROM sync_failures                           │
│        WHERE status IN ('pending','retrying')              │
│        AND (kinds filter) AND (branch filter)              │
│        ORDER BY created_at LIMIT limit (≤50)               │
│    • For each row:                                         │
│        - cooldown check (LAST_ATTEMPT_BACKOFF_SECONDS=60)  │
│        - UPDATE status='retrying', attempts++              │
│        - dispatch via retryFailureItem(row)                │
│        - on ok  → status='resolved', payload+autoResolved* │
│        - on err → if attempts ≥ MAX_ATTEMPTS (5) → 'dead'  │
│                  else → status='pending' + lastRetryReason │
│    • Returns RetryTickResult { processed, succeeded,       │
│                                failed, dead, skipped,      │
│                                items[]: per-row outcome }  │
│    • Never throws.                                         │
└──────────────┬─────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────┐
│  retryFailureItem(row, ctx)                                │
│    order_to_sheet  → syncOrderToSheetCore(targetId)        │
│    line_send       → dispatchLineKind(payload.messageKind) │
│                       → sendOrder{Created,Ready}Message /  │
│                         sendPickupReminderMessage /        │
│                         sendReceiptMessage                 │
│                       (LINE "skipped" treated as success)  │
│    receipt_rebuild → no-op success                         │
│    others          → manual-retry-only                     │
└────────────────────────────────────────────────────────────┘
```

#### Safety limits (constants)

| Constant | Value | Purpose |
|---|---|---|
| `MAX_ATTEMPTS` | 5 | After 5 dispatches a row goes `dead`. |
| `LAST_ATTEMPT_BACKOFF_SECONDS` | 60 | Per-row cooldown — protects LINE customers from spam. |
| Hard limit per tick | 50 | Keeps one serverless invocation inside its timeout. |
| Bulk-resolve cap | 100 | Per request. |

#### Bulk-resolve route

`POST /api/admin/recovery/bulk-resolve` is the sibling endpoint. Takes `failureIds: string[]` (≤100), per-row branch check (managers refused on foreign-branch rows), stamps every successful row with a shared `bulkActionId` in `payload.jsonb` for grouping.

#### Cron entry point (post-2026-05-14)

`GET / POST /api/cron/retry-worker` is the scheduled trigger. Auth shape: bearer token equal to `CRON_SECRET`. Vercel Cron sends that header automatically when `CRON_SECRET` is defined; Supabase Cron is configured the same way (see `app/api/cron/retry-worker/route.ts` header comment for the SQL).

The route calls `runRetryTick({ actorId: 'cron', limit })` and returns the per-row summary. The worker writes one `public.worker_runs` row per tick (heartbeat) — `/admin/recovery` reads the most recent `actor_id='cron'` row to render "Last cron tick: 3m ago".

#### Per-kind retry policy

`lib/retryPolicy.ts` is the single source of truth. The worker reads `getRetryPolicy(row.kind)` and obeys:

| kind | autoRetry | maxAttempts | cooldown |
|---|---|---|---|
| `order_to_sheet` | ✅ | 10 | 30 s |
| `line_send` | ✅ | 3 | 300 s |
| `receipt_rebuild` | ✅ | 3 | 60 s |
| `pricing_to_sheet` | ❌ | — | — |
| `customer_from_sheet` | ❌ | — | — |
| `expense_from_sheet` | ❌ | — | — |
| `debug_to_sheet` | ❌ | — | — |
| unknown | ❌ (safe default) | 3 | 300 s |

The admin panel surfaces this exact table inside the "Auto-retry status" expandable section on `/admin/recovery`. Operators can verify behaviour without reading code.

---

## 12e. Google Sheet dedup (post-2026-05-14)

Front_Desk orders are now idempotent — the retry worker and any manual "ลองใหม่" produces zero duplicate rows. Two new building blocks:

| Helper | File | Purpose |
|---|---|---|
| `findRowByColumnValue(tab, "B", jobId)` | [`lib/googleSheets.ts`](../lib/googleSheets.ts) | `values.get` on a single column, returns the 0-indexed match row or -1. |
| `updateRowValues(tab, rowIndex, values, { preservedColumns })` | [`lib/googleSheets.ts`](../lib/googleSheets.ts) | `values.update` PUT per contiguous run of non-preserved columns. Operator-managed checkboxes (Front_Desk M/N/O) are preserved on update. |

`writeOrderRow` now:
1. Tries `findRowByColumnValue` for the Job ID.
2. If found → `updateRowValues` with preserved [12,13,14] → result `mode: "updated"`.
3. Otherwise → fall through to `insertFormattedRow` → result `mode: "appended"`.
4. Lookup failures (auth glitch, rate limit) log a warning and fall back to append — single-shot syncs keep working.

Tabs that are append-only by design (`Pricing`, `Expense_Log`, `Debug`) skip dedup entirely. See [GOOGLE_SHEET_SYNC.md §8b](./GOOGLE_SHEET_SYNC.md) for the full contract.

---

## 12g. Customer identity foundation (post-`20260530`)

> Status: **foundation live**. See [CUSTOMER_IDENTITY.md](./CUSTOMER_IDENTITY.md) for the full identity contract.

### 12g.1 Linker UI

```
┌──────────────────────────────────────────────────────────┐
│  /admin/customer-line  (owner / hq_admin only)           │
│    • Unmatched tab: customer_line_links where            │
│        customer_id IS NULL AND ignored_at IS NULL         │
│    • Linked tab: rows with customer_id set                │
│    • Review modal:                                       │
│        - fetchRecentFollowEvents(lineUserId, 10)         │
│        - suggestLikelyCustomerMatches({...})             │
│            phone exact (95) > name exact (75) > prefix    │
│            (60) > substring (50) > recent activity (30)   │
│        - Phone + name hint inputs to refine suggestions  │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼ POST /api/admin/customer-line/{link|unlink|ignore}
               │   (each enforces requireRole(owner / hq_admin) +
               │    admin-client write so RLS doesn't block branch-
               │    spanning customer pairing)
               ▼
        UPDATE customer_line_links SET ...
```

### 12g.2 Reconcile job

```
┌──────────────────────────────────────────────────────────┐
│  POST /api/admin/reconcile/run                           │
│    requireRole(owner / hq_admin / branch_manager)        │
│    branch_manager: branchCode FORCED to profile branch   │
└──────────────┬───────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────┐
│  lib/reconcile.ts::runReconcileTick(opts)                │
│    1. Fetch Front_Desk!B once → Map<jobId, rows[]>       │
│    2. Last-N-days orders scan:                           │
│         - missing from sheet  → reconcile_missing_sheet  │
│         - duplicate in column → reconcile_duplicate_sheet│
│    3. customer_line_links unlinked + un-ignored 7+ days  │
│         → reconcile_orphan_link                          │
│    4. For each new mismatch: enqueueMismatch()           │
│         - checks for an open (kind, target_id) first     │
│         - inserts a sync_failures row otherwise          │
│    5. Persist a reconcile_runs row (heartbeat).          │
│    Returns RetryTickResult-shaped summary.               │
└──────────────────────────────────────────────────────────┘
```

### 12g.3 Why reconcile reuses sync_failures

Operationally, "platform tried X and failed" and "platform noticed a divergence" both need the same admin actions: filter, retry, resolve, inspect. Reusing the recovery UI saves a parallel surface; the retry-worker auto-handles `reconcile_missing_sheet` via the existing dedup-safe sync path. Manual-only kinds (`reconcile_duplicate_sheet`, `reconcile_orphan_link`) sit in the queue until an admin resolves them by hand.

Trade-off: `sync_failures` semantics widens. Documented as a known compromise; a dedicated `reconcile_mismatches` table is a clean future migration if reconcile complexity outgrows the CHECK constraint.

### 12g.4 Branch isolation summary

| Layer | Linker (`/admin/customer-line`) | Reconcile (`/admin/recovery`) |
|---|---|---|
| Page key | `admin` (owner / hq_admin only — branch_manager doesn't have it) | `recovery` (owner / hq_admin / branch_manager) |
| RLS read | `customer_line_links_admin_full` / `customer_line_links_branch_read` (read-only for managers) | `sync_failures_admin_read` + `sync_failures_branch_read` |
| Server route | `requireRole(['owner','hq_admin'])` on every write | `requireRole(['owner','hq_admin','branch_manager'])` + branch_manager's branchCode forced |
| Heartbeat read | n/a | `reconcile_runs` admin-read only |

---

## 12f. LINE follow webhook foundation (post-`20260529`)

> Status: **webhook receive path live**. Customer linker UI deferred — once an admin pairs a `line_user_id` with a real customer row, the existing send orchestrator picks up the link automatically.

```
LINE platform → POST /api/line/webhook
                  ▲
                  │ x-line-signature: base64(HMAC-SHA256(LINE_CHANNEL_SECRET, raw))
                  ▼
           lib/lineWebhook.ts
             • verifyLineSignature(raw, header)  — constant-time compare
             • processLineWebhookBody(parsed, verified)
                 ↓
     Always:  INSERT line_follow_events  (audit row, signature_verified=true/false)
                 ↓ (when verified + line_user_id present)
     follow:  UPSERT customer_line_links (customer_id=NULL, consented_at=now())
     unfollow: UPDATE customer_line_links SET unsubscribed_at=now()
     message / other: audit only, no state change
```

### 12f.1 Why customer_line_links uses `customer_id=NULL` at first

The webhook can't tell which customer just followed the OA — LINE only gives us the opaque `line_user_id`. The follow row is created upfront so a future admin linker UI can pair it with a real customer record (typically by asking the customer to type their phone in a LINE message and matching against `public.customers`). Until that pairing happens:
- `lib/lineDelivery.ts` looks up by `customer_id` — unmapped follows return nothing — so no message ever fires to an unknown account.
- The unique index `customer_line_links_line_user_id_uniq` keeps duplicate follows from creating duplicate rows.

### 12f.2 Why the route always returns 200

LINE's webhook contract disables a channel that repeatedly returns 4xx/5xx. Signature failures, unparseable JSON, and processor errors all return 200 — but the failure is captured in `line_follow_events` with `signature_verified=false` (or the response body contains `ok: false, reason: ...`). Admin postmortem reads the audit table; LINE keeps delivering.

### 12f.3 Env vars

| Env var | Purpose | Behaviour when unset |
|---|---|---|
| `LINE_CHANNEL_SECRET` | HMAC key for signature verification | Every event records `signature_verified=false`; customer_line_links is never touched. Audit-only mode. |
| `SUPABASE_SERVICE_ROLE_KEY` | Webhook writes | Processor returns `{ ok: false, reason: "SERVICE_ROLE_KEY ..." }` and skips writes. |

### 12f.4 Console setup

LINE Developer Console → channel settings:
1. Webhook URL: `https://<deploy>/api/line/webhook`
2. "Use webhook" → enabled.
3. Press "Verify" — should return 200 (route's GET handler answers with a small JSON ack).

---

## 12h. Management intelligence foundation (post-`20260531`)

> Status: **foundation live**. Payroll write surface + customer-tier writer + materialised dashboard snapshot. UI lives in `/admin/payroll` and `/customers`; reads are routed through `lib/aggregationService.ts`.

### 12h.1 Payroll write layer

```
┌──────────────────────────────────────────────────────────┐
│  /admin/payroll  (owner / hq_admin only)                 │
│    • Picks (branch, year, month).                        │
│    • Loads payroll_periods row + active technicians.     │
│    • For each tech: calculateEstimatedPayroll(...) reads │
│      technician_daily_kpi to derive baseWage / target /  │
│      production / performance ratio.                     │
│    • Admin tweaks bonus / deduction → "Save".            │
│    • Finalize → mark paid (state machine).               │
└──────────────┬───────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────┐
│  POST /api/admin/payroll/{open-period,save-item,         │
│                            transition}                   │
│    • requireRole(owner / hq_admin) on every route.       │
│    • upsertPayrollItem refuses writes when period.status │
│      = 'paid' (immutability rule).                       │
│    • Server recomputes final_pay = base + bonus − ded.   │
└──────────────────────────────────────────────────────────┘
```

State machine (full table in [PAYROLL.md §4](./PAYROLL.md)):

```
open → (finalize) → finalized → (mark paid) → paid (immutable)
```

### 12h.2 Customer tier writer

```
public.customers
  ├ customer_tier      (PREMIUM / VIP / REGULAR / INACTIVE)
  ├ lifetime_spend
  ├ last_visit_at
  ├ primary_branch_id  (branch slug with most orders)
  └ total_orders / latest_service

lib/customerTierService.ts
  ├ calculateCustomerTier(stats)         — pure
  ├ computeCustomerStats(customerId)     — admin client read
  ├ refreshCustomerTier(customerId)      — write back to customers
  └ refreshBranchCustomerTiers(branch)   — batch (limit 2000)
```

Thresholds in `TIER_THRESHOLDS` — change-in-one-place tuning. Full rules in [CUSTOMER_TIER.md §1](./CUSTOMER_TIER.md).

Refresh today: admin button on `/customers` calls `POST /api/admin/customer-tier/refresh`. Future cron is documented in §6 of CUSTOMER_TIER.md.

### 12h.3 Materialised dashboard snapshot

```
public.dashboard_daily_snapshot  (matview, branch_code × work_date)
  total_orders / completed_orders / ready_orders / urgent_orders /
  revenue / paid_revenue / urgent_fee_total /
  material_cost_total / labor_cost_total

public.refresh_dashboard_daily_snapshot()   (SECURITY DEFINER)
  • refresh materialized view concurrently <view>
  • on first refresh (WITH NO DATA), falls back to non-concurrent path

lib/aggregationService.ts
  ├ fetchBranchSalesSummary       ← reads from the matview
  ├ fetchPayrollTotals            ← reads technician_payroll_items
  ├ fetchTopServices              ← reads orders directly (matview
  │                                  doesn't materialise per-service yet)
  ├ fetchOverdueTrends            ← reads orders directly
  ├ fetchCustomerGrowth           ← reads customers.created_at
  └ refreshDashboardSnapshot      ← calls the SQL function

POST /api/admin/dashboard/refresh-snapshot   (owner / hq_admin)
GET  /api/admin/dashboard/refresh-snapshot   (Bearer CRON_SECRET — cron)
```

**Why service-role only on reads.** RLS doesn't apply to matviews; we revoke direct read from `anon` + `authenticated` so a misconfigured client can't expose every branch's daily numbers. Every read goes through the admin client in a server context that applies branch isolation manually before returning data to a non-admin role.

**Why the existing dashboard isn't swapped yet.** Foundation phase. The page (`app/page.tsx`) still reads orders + expenses directly via `lib/dashboardData.ts`. Swapping to the snapshot is a next-phase task because (a) we want the snapshot to accumulate data first and (b) the swap needs a careful side-by-side QA pass. The aggregation service is the seam — when the swap happens, only `lib/dashboardData.ts` changes.

### 12h.4 Branch isolation across this phase

| Surface | Owner / HQ | Branch_manager | Front_staff / Technician |
|---|---|---|---|
| `/admin/payroll` UI | ✅ | ❌ (admin page key) | ❌ |
| `payroll_periods` read | ✅ | ✅ 🏢 (RLS) | ❌ |
| Payroll writes | ✅ | ❌ | ❌ |
| `/customers` tier badge | ✅ | ✅ 🏢 | ✅ 🏢 (read) |
| Refresh tier route | ✅ all | ✅ 🏢 (branchCode forced) | ❌ |
| `dashboard_daily_snapshot` | ⚠ service-role only | ⚠ service-role only | ⚠ service-role only |
| Refresh snapshot route | ✅ | ❌ | ❌ (cron has its own auth) |

---

## 12i. Scale-out foundation (post-`20260532`)

> Status: **foundation live**. Three thin layers complete the scale-out story: the dashboard now opportunistically reads from the materialised snapshot, the payroll UI pre-fills a suggested bonus, and HQ can spin up a new branch end-to-end through `/admin/onboarding`. See [DASHBOARD.md](./DASHBOARD.md), [FRANCHISE_ONBOARDING.md](./FRANCHISE_ONBOARDING.md), [PAYROLL.md §7b](./PAYROLL.md).

### 12i.1 Dashboard snapshot swap

The dashboard now reads from **two parallel paths**:

```
app/page.tsx
  ├─ fetchDashboardSnapshot()             ← live (per-row arrays for queues)
  └─ fetchSnapshotSummary()
        ↓
        GET /api/admin/dashboard/summary
        ↓
        fetchBranchSalesSummary()         ← matview if non-empty
        ↓
        liveFallback() over last 30 days  ← else
        ↓
        returns { totals, usingSnapshot, snapshotRefreshedAt }
```

The freshness indicator in the page header shows `📊 snapshot · 2026-05-14` when the matview backed the read, or `⚡ live (fallback)` when it didn't. Operational widgets (queues, urgent list, overdue) still consume per-row data from the live fetch — by design, see [DASHBOARD.md §2.1](./DASHBOARD.md).

### 12i.2 Bonus engine

```
lib/bonusEngine.ts
  ├ BONUS_RULES                  (versioned config in code)
  ├ calculateSuggestedBonus(...)  (pure)
  └ isOverride(suggestion, saved) (UI helper)

formula (v1-perf-overage-20pct):
  overage = max(0, performanceRatio − 1.0)
  amount  = min(overage × baseWage × 0.20, baseWage × 1.0)

persistence:
  technician_payroll_items.bonus_suggested      ← engine output at save time
  technician_payroll_items.bonus_rule_version   ← rule identifier
  technician_payroll_items.bonus_amount         ← what the owner kept
```

The owner can freely override — the engine is advisory. `upsertPayrollItem` recomputes the suggestion server-side so a malicious caller can't fake the audit trail.

### 12i.3 Branch onboarding wizard

```
POST /api/admin/onboarding/create-branch
  • Validates code (slug regex) + short_code (upper alpha-numeric)
  • Rejects duplicate code with HTTP 409 (friendly message)
  • Inserts branches row with is_active=false
  • Optional: inserts empty branch_line_configs row

POST /api/admin/onboarding/activate-branch
  • Flips branches.is_active. Idempotent on no-op.
```

UI surfaces a three-section single-page wizard at `/admin/onboarding`:

1. Branch basics (code, short_code, name, type, brand).
2. Reserve config slots (LINE config placeholder).
3. Manual checklist for the steps the wizard can't do automatically (brandConfig.ts mirror, staff pin, LINE token UPDATE, pricing review).

Existing branches are listed in a table with per-row activate / deactivate buttons. Inactive is the safety default — the operator must explicitly confirm before customers can place orders against a new branch.

### 12i.4 Branch isolation summary

| Surface | Owner / HQ | Branch_manager | Front_staff / Technician |
|---|---|---|---|
| Dashboard summary | ✅ any branch | ✅ 🏢 (branchCode forced) | ✅ 🏢 | 
| Bonus engine | ✅ (free override) | ❌ (no payroll UI) | ❌ |
| `/admin/onboarding` | ✅ | ❌ (admin page key) | ❌ |
| Create / activate branch | ✅ | ❌ | ❌ |

---

## 12j. Verification + snapshot swap + DB-driven brand (post-`20260533`)

> Status: **shipped**. Verification round confirmed all 13 critical workflows PASS. Dashboard role components now opt into the snapshot for date-bucketed sales metrics. branchContext reads UI metadata from `public.branches` with `lib/brandConfig.ts` as fallback.

### 12j.1 Verification round outcomes

A code-walk audit confirmed every workflow listed in the task PASSes:

- Login + role visibility ✅
- Intake + Job ID race-safety ✅
- Pricing / urgent / B2S promotion ✅
- Technician assignment + inactive-tech rejection ✅
- Receipt + dedup contract ✅
- LINE notification + branch ownership ✅
- Recovery + bulk-resolve + retry worker + dead-after-max ✅
- Payroll + bonus engine + immutable-paid ✅
- Customer tier + INACTIVE precedence ✅
- Onboarding + duplicate-code rejection + is_active=false ✅
- Dashboard snapshot route + branch-forced for non-admin ✅
- Cron retry-worker auth ✅
- LINE webhook signature + audit-only on unverified ✅

No CRITICAL or HIGH issues found. Branch isolation is enforced consistently across UI / RLS / route guard. Silent-failure paths log structured warnings.

### 12j.2 Snapshot widget swap

```
app/page.tsx
  ├ fetchDashboardSnapshot()        — live per-row arrays
  └ fetchSnapshotSummary()
        ↓
        GET /api/admin/dashboard/summary
        ↓ returns { totals, rows[], usingSnapshot, snapshotRefreshedAt }
        ↓
        assembleSnapshotKpis(rows)  — produces SnapshotKpiBundle

DashboardView passes snapshotKpis to:
  • ManagerDashboard       (today / this month)
  • AccountingDashboard    (today / this month / last month)
  • ExecutiveDashboard     (today / this month / last month / MoM)

Each component:
  if (snapshotKpis?.hasData) use bundle value
  else                       fall back to live filter+sumRevenue
```

Operational tables / queues / per-row attributes (top services, pending lists, urgent queue, customer cohort, payment mix) **stay live** because the day-granular matview doesn't carry that detail. Documented in [DASHBOARD.md §8](./DASHBOARD.md).

### 12j.3 BrandConfig DB mirror

`public.branches` gains UI-metadata columns (short_label, short_name, receipt_name, tagline, address, phone, logo_path, accent_class). `lib/branchContext.tsx` fetches from DB on session start and falls back to the seeded list per field:

```
useEffect:
  data = supabase.from("branches").select(...).eq("is_active", true)
  if data.length > 0:
    branches = data.map(mapDbRow)
    source = "db"
  else:
    branches = STATIC_BRANCHES (lib/brandConfig.ts)
    source = "fallback"

mapDbRow per field:
  shortLabel = row.short_label ?? seed.shortLabel ?? `${short_code} • ${name}`
  // …same fallback chain for every UI field
```

The onboarding wizard now collects every UI field (sensible defaults when blank) and writes them at create time, so a new branch renders correctly without a code edit. brandConfig.ts stays as the safety fallback for the two seeded branches.

### 12j.4 Branch isolation summary

Verification confirmed every gate still holds:

| Surface | Branch_manager | Front_staff / Technician |
|---|---|---|
| `/admin/onboarding` | ❌ admin page key | ❌ |
| Onboarding routes | ❌ owner / hq_admin only | ❌ |
| `/api/admin/dashboard/summary` | branchCode forced | branchCode forced |
| `dashboard_daily_snapshot` direct read | revoked from authenticated | revoked |
| `branches` table read (DB mirror) | scoped by RLS / public read of active rows | scoped |

---

## 12k. Public website + CRM foundation (post-`20260534`)

> Status: **foundation live**. See [PUBLIC_WEBSITE.md](./PUBLIC_WEBSITE.md) and [CRM_FOUNDATION.md](./CRM_FOUNDATION.md).

The platform now serves **two surfaces** from the same Next.js deployment + same database:

```
┌──────────────────────────────────────────────────────────────┐
│  OPS (existing)                                              │
│    /, /orders, /customers, /admin/*, /reports/*, /intake,    │
│    /invoices, /expenses, /pricing                            │
│    Auth: LINE login + HMAC cookie + JWT bridge → RLS         │
│    Audience: owner / hq_admin / branch_manager /             │
│              front_staff / technician                         │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  PUBLIC WEBSITE (this phase)                                 │
│    /website, /branches[/code], /services, /track, /quote,    │
│    /about, /contact                                          │
│    Auth: anonymous (rate-limited; phone+jobId for /track)    │
│    Audience: customers + prospects                            │
│    Database access: service-role admin client through hand-  │
│    written server routes that emit narrow column subsets.    │
│    Direct anon read of operational tables is denied by RLS.  │
└──────────────────────────────────────────────────────────────┘
```

### 12k.1 Route group separation

`app/(public)/` is the route group that owns the public layout (no OPS sidebar, public header + footer). The OPS `Sidebar` component short-circuits when `pathname` starts with a public prefix; `lib/authContext.tsx::isPublicPath` checks the same prefix list so anonymous visitors don't get bounced to `/login`.

### 12k.2 Public API security

| Route | Auth | Rate-limit |
|---|---|---|
| `/api/public/branches-list` | none | none (read-only public list) |
| `/api/public/track` | phone + jobId match | 10/min/IP + 5/min/(IP, jobId) |
| `/api/public/quote` | none | 5/hour/IP |

All three call `getSupabaseAdmin()` server-side and return hand-picked column subsets. RLS is bypassed for the read so the customer can lookup across branches; the route layer is the security boundary.

`/api/public/quote` also inserts a `customer_activity` row with `kind: 'quote_submitted'` and `customer_id: null` so the future CRM timeline captures every inbound request from day one.

### 12k.3 CRM scaffolding

Five new tables (see [CRM_FOUNDATION.md](./CRM_FOUNDATION.md) for the full schema):

| Table | Purpose |
|---|---|
| `customer_tags` | Free-form text labels per customer (unique per `(customer_id, lower(tag))`). |
| `customer_notes` | Branch-scoped free-form notes. Front_staff can write within their branch. |
| `customer_activity` | Append-only event log. `kind` is text (no CHECK) so future writers don't migrate. |
| `customer_channels` | Generalised contact channels (phone / email / line / web / other). |
| `quote_requests` | Inbox for public /quote submissions. Anon INSERT allowed via RLS. |

Branch isolation: tables with their own `branch_id` (notes, activity, quote_requests) join directly; tables without (tags, channels) join through `customers.branch_id`. Owner / hq_admin always pass; front_staff + branch_manager are scoped to their own branch.

### 12k.4 Theme system

`lib/publicTheme.ts` produces a `PublicTheme` from either a brand key (Care U or Ezy) or a `BranchTheme` (mapped from `public.branches`). Per-branch overrides cascade per-field over the brand default so a partial DB row never renders blank. The single-branch page `/branches/[code]` uses the per-branch theme; cross-brand pages (`/website`, `/services`, etc.) use the Care U default.

### 12k.5 SEO

Each public page exports `metadata` (Thai-first title + description). `app/sitemap.ts` returns the static page list plus one URL per active branch (pulled from `public.branches`). `app/robots.ts` allows public prefixes and disallows `/api`, `/admin`, OPS routes.

---

## 12c. Operational UI foundation (post-2026-05-14)

Three pieces ship together to standardise the operational surface without touching architecture:

### 12c.1 Status vocabulary
[`lib/statusBadges.ts`](../lib/statusBadges.ts) is the single source of truth for order status, payment status, and sync status. Every screen reads labels + Tailwind colour classes from this module via the `components/StatusBadge.tsx` wrappers. Adding a new status = update the map once; the whole storefront picks it up. Status helpers (`orderStatusLabel`, `paymentStatusLabel`, `isOverdue`) are pure functions, safe on server and client.

### 12c.2 Quick action shape
[`components/QuickActionButton.tsx`](../components/QuickActionButton.tsx) is the shared button shape for operational actions — print, send LINE, mark ready, assign technician, resync sheet. Built-in:
- 44 px minimum tap target (`min-h-[44px]`) for tablet ergonomics.
- Four tone variants (`primary`, `secondary`, `danger`, `neutral`).
- `loading` / `disabled` states + `print:hidden` default so printed receipts stay clean.

Pages adopt the component opportunistically; old buttons keep working until rewritten.

### 12c.3 Admin foundation
- [`app/admin/page.tsx`](../app/admin/page.tsx) — operator landing for owner / hq_admin. Cards link to staff management, pricing, and a stubbed sync-recovery placeholder.
- [`app/admin/staff/page.tsx`](../app/admin/staff/page.tsx) — single-screen staff management. Reads via [`lib/staffService.ts`](../lib/staffService.ts), which joins `profiles → branches` and embeds the matching `technician_profiles` row when present. Writes go through `updateProfileRole` and `upsertTechnicianProfile`.
- Gated by the new `"admin"` `PageKey` in `lib/roles.ts`. Branch-locked roles never see the route.

### 12c.4 Navigation grouping
The sidebar groups nav items into three semantic buckets — **Operations** (Dashboard, Intake, Orders, Customers), **Finance** (Invoices, Expenses, Reports), and **Management** (Pricing, Admin centre). The group label only appears when the role sees more than one group, keeping `front_staff` and `technician` views compact.

The mobile menu button is a 44 px square. Tabs that previously wrapped now scroll horizontally (`overflow-x-auto` + `shrink-0`) so each option remains a real tap target on a phone.

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
├── admin/page.tsx                      ← Admin centre landing (owner / hq_admin)
├── admin/staff/page.tsx                ← Staff list + role/branch/active/wage/skills
├── admin/recovery/page.tsx             ← Sync failures + LINE log + receipt rebuild + reconcile tab + bulk actions
├── admin/customer-line/page.tsx        ← Customer ↔ LINE linker (unmatched + linked tabs)
├── admin/payroll/page.tsx              ← Technician payroll (preview / bonus engine / finalize / mark paid)
├── admin/onboarding/page.tsx           ← Branch onboarding wizard + activate / deactivate
├── api/admin/recovery/resolve/route.ts ← Gated mark-resolved write
├── api/admin/recovery/bulk-resolve/route.ts  ← Bulk resolve (≤100 ids)
├── api/admin/recovery/run-worker/route.ts    ← Manual retry-worker trigger
├── api/admin/reconcile/run/route.ts          ← Manual reconcile trigger
├── api/admin/customer-line/link/route.ts     ← Pair LINE follower with customer
├── api/admin/customer-line/unlink/route.ts   ← Break a LINE-customer pairing
├── api/admin/customer-line/ignore/route.ts   ← Hide a probe / non-customer follower
├── api/admin/customer-tier/refresh/route.ts  ← Recompute customer tier insight columns
├── api/admin/dashboard/refresh-snapshot/route.ts ← Refresh materialised dashboard view
├── api/admin/payroll/open-period/route.ts    ← Idempotent payroll period open
├── api/admin/payroll/save-item/route.ts      ← Upsert technician payroll item
├── api/admin/payroll/transition/route.ts     ← open → finalized → paid
├── api/admin/dashboard/summary/route.ts      ← Snapshot-backed dashboard KPIs + live fallback
├── api/admin/onboarding/create-branch/route.ts ← Create a new branch (inactive default)
├── api/admin/onboarding/activate-branch/route.ts ← Flip branches.is_active
├── api/cron/retry-worker/route.ts            ← Scheduled retry-worker (CRON_SECRET)
├── api/line/webhook/route.ts                 ← LINE follow / unfollow webhook
├── api/public/track/route.ts                 ← Public job-tracking lookup (rate-limited)
├── api/public/quote/route.ts                 ← Public quote-request submission
├── api/public/branches-list/route.ts         ← Public active-branches dropdown
├── (public)/layout.tsx                       ← Public-website route group layout
├── (public)/website/page.tsx                 ← Public marketing landing
├── (public)/branches/page.tsx                ← Active branches grid
├── (public)/branches/[branchCode]/page.tsx   ← Single-branch detail with brand theme
├── (public)/services/page.tsx                ← Catalog grouped by category
├── (public)/track/page.tsx                   ← Customer job tracking form
├── (public)/quote/page.tsx                   ← Quote-request form
├── (public)/about/page.tsx                   ← Static brand story
├── (public)/contact/page.tsx                 ← Contact options
├── sitemap.ts                                ← Dynamic sitemap incl. branch URLs
├── robots.ts                                 ← Allow public, disallow /api + /admin + OPS
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
├── Sidebar.tsx                         ← grouped operational nav + auth + branch selector
├── StatusBadge.tsx                     ← OrderStatusBadge / PaymentStatusBadge / SyncStatusBadge
├── QuickActionButton.tsx               ← shared 44px touch-target action button
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
├── dashboardKpi.ts   ← operational KPI helpers + assembleKpis bundle
├── receiptData.ts    ← buildReceiptData / Items / Totals / PaymentSummary
├── printService.ts   ← printReceipt / saveReceiptAsImage + PDF/LINE stubs
├── auditService.ts   ← unified recordAudit(domain, action, target, …)
├── validation.ts     ← validateOrderInput / Expense / Pricing / BranchAssignment / TechnicianAssignment
├── recoveryService.ts ← listFailedSyncs / markSyncResolved / resyncOrderToSheet / rebuildReceiptData
├── syncFailures.ts   ← console.error + fire-and-forget public.sync_failures persist
├── lineConfig.ts     ← per-branch channel token resolver (DB → env fallback)
├── lineMessaging.ts  ← server-only LINE Messaging API push client
├── lineMessageBuilders.ts ← pure Thai-text builders for 4 message kinds
├── lineDelivery.ts   ← orchestrator: send + log + per-customer prefs
├── lineOA.ts         ← browser-side wrappers (sendLineMessage + legacy sendToLineOA)
├── staffService.ts   ← /admin/staff data layer (fetch profiles, upsert technician_profiles)
├── statusBadges.ts   ← canonical status / payment / sync vocabulary (labels + colours)
├── orderSheetSync.ts ← syncOrderToSheetCore (route + worker share this)
├── retryWorker.ts    ← runRetryTick + retryFailureItem + worker_runs heartbeat
├── retryPolicy.ts    ← per-kind RETRY_POLICIES map + getRetryPolicy helper
├── lineWebhook.ts    ← verifyLineSignature + processLineWebhookBody
├── customerMatching.ts ← findCustomerByPhone / Name / Recently + suggestion combiner
├── customerLinker.ts ← fetchUnmatched / Linked + link / unlink / ignore wrappers
├── reconcile.ts      ← runReconcileTick + 3 checks (orders↔sheet, duplicate, orphan)
├── customerTierService.ts ← calculateCustomerTier + refreshCustomerTier + refreshBranchCustomerTiers
├── aggregationService.ts ← materialised-view reads + refreshDashboardSnapshot
├── bonusEngine.ts        ← calculateSuggestedBonus + BONUS_RULES + isOverride
├── dashboardSnapshotKpi.ts ← assembleSnapshotKpis + date-bucketed helpers over matview rows
├── rateLimit.ts          ← in-memory token bucket for /api/public/* routes
└── publicTheme.ts        ← BRAND_THEMES + themeForBranch for the customer-facing website

components/receipt/
├── ReceiptA4.tsx        ← full-page branded receipt
├── ReceiptThermal.tsx   ← 80mm monospace strip
├── ReceiptMobile.tsx    ← single-column phone layout
├── ReceiptCommon.tsx    ← shared status/payment badges + QR placeholder
└── PrintModeSelector.tsx

supabase/migrations/
└── 20260512..20260525 (see §7)
```

---

## 17. Known operational risks

See [TESTING_REPORT.md](./TESTING_REPORT.md) for the full bug list, severity ratings, and production-readiness assessment from the operational testing phase. Key carry-forward risks:

- Deploying with `SUPABASE_JWT_SECRET` unset silently empties every RLS-protected screen. A red banner (`components/AuthHealthBanner.tsx`) now warns operators, but the deploy checklist should still verify the secret is set before rollout.
- A profile with `branch_id IS NULL` for a non-admin role shows the default branch label with a disabled select. Audit profile rows after promotion or harden the auth callback to reject null branch for branch-scoped roles.
- `customers.total_orders / latest_service / customer_tier` columns exist but no writer maintains them. Either ship a trigger or stop reading them until the maintenance phase lands.
- `sync_failures.kind` does not yet distinguish LINE pushes from Sheet syncs. A future retry worker must extend the CHECK constraint before consuming the queue.

---

**Last updated:** 2026-05-14 (public website + CRM foundation — `app/(public)/*`, `/api/public/*`, `20260534` migration, new `PUBLIC_WEBSITE.md` + `CRM_FOUNDATION.md`)
