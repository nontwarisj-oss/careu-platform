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
| `20260535_customer_portal_and_crm_progression.sql` | `customer_otp_codes` (phone+OTP sign-in, hashed codes), `customer_notifications` (outbound queue). `customers` gets `lifecycle_stage` + `retention_score` columns (computed by `crmProgressionService`). Private Supabase Storage bucket `customer-uploads` created via `storage.buckets`. Admin-read RLS on the two new tables. |

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

## 12l. Customer portal + uploads + CRM progression (post-`20260535`)

> Status: **foundation live**. Phone+OTP sign-in, customer-safe order surface, signed-URL upload pipeline, CRM progression columns + service, notification queue. SMS provider + dispatcher worker + customer-facing language switcher are deliberately deferred.

See [CUSTOMER_PORTAL.md](./CUSTOMER_PORTAL.md), [UPLOADS.md](./UPLOADS.md), and [CRM_FOUNDATION.md](./CRM_FOUNDATION.md) for surface-by-surface specs.

### 12l.1 Two cookies, one secret

```
careu_session            ── OPS  (operator)  ── set by /api/auth/line/callback
careu_customer_session   ── PORTAL (customer)── set by /api/portal/auth/verify-otp
```

Both signed HMAC-SHA256 with `SESSION_SECRET`. Cookie name + payload shape diverge so a forged operator cookie can never satisfy a portal route (and vice versa). Both are HttpOnly + SameSite=Lax + Secure-in-prod.

### 12l.2 OTP sign-in

```
/portal/signin
  ├─ phone form → POST /api/portal/auth/request-otp
  │                ├─ rate-limit 5/10min/IP
  │                └─ customerOtp.issueCustomerOtp(phone)
  │                     • normalises phone
  │                     • invalidates older un-consumed codes
  │                     • inserts customer_otp_codes (hashed)
  │                     • logs the code (no SMS gateway yet)
  │
  └─ code form → POST /api/portal/auth/verify-otp
                   ├─ customerOtp.verifyCustomerOtp(phone, code)
                   │    • constant-time hash compare
                   │    • universal dev code "123456" in non-prod
                   │    • caps attempts at 5
                   ├─ identityResolver.findOrCreateByPhone(phone)
                   ├─ customerSession.encodeCustomerSession(...)
                   ├─ customerSession.setCustomerSessionCookie(value)
                   └─ crmProgressionService.refreshCustomerProgression(id)
```

### 12l.3 Customer-safe data shapes

Every portal API route handpicks the response shape. `orders.labor_cost`, `material_cost`, `tech`, `assigned_technician_id`, and free-form `notes` never reach the customer. Wrong-owner attempts on `/api/portal/orders/[id]` get the same 404 as a missing id — no enumeration leak.

### 12l.4 Upload pipeline

```
client
  └─ POST /api/{public,portal}/upload-url
       ├─ rate-limit  (public 10/hr, portal 30/10min)
       ├─ MIME + size + scope validation
       └─ uploadService.issueUploadUrl
            └─ admin.storage.from('customer-uploads')
                 .createSignedUploadUrl(<branch>/{scope}/<id>/<uuid>.<ext>)
            → returns { signedUrl, token, path, expiresAt }

client PUTs bytes directly to signedUrl (bypasses the platform).
client stores `path` in quote_requests.photos (or future order_attachments).
```

Bucket `customer-uploads` is private. Read access via `issueReadUrl(path, ttl)` — short-lived signed GET URLs the portal / admin renderers use.

### 12l.5 CRM progression

`lib/crmProgressionService.ts` is the writer for two new `customers` columns:

| Column | Domain | Source |
|---|---|---|
| `lifecycle_stage` | `new` / `active` / `at_risk` / `dormant` / `reactivated` / `churned` | `calculateLifecycleStage(stats)` — top-down rules on recency + frequency + prior stage |
| `retention_score` | 0–100 | `calculateRetentionScore(stats)` — weighted recency (50 %) + frequency (30 %) + spend (20 %) |

Sibling to `customerTierService` (which produces `customer_tier`). The two answer different questions: tier is "how valuable?", lifecycle is "where in the relationship?". Future automation reads `lifecycle_stage` to drive reactivation campaigns without re-computing per call.

### 12l.6 Notification queue

`lib/notificationService.ts::enqueueNotification` writes to `customer_notifications` and returns. Channels: `line`, `email`, `in_app`, `sms`. Status flow: `queued → sending → (sent|failed|skipped)`. **No dispatcher worker this phase** — the table is the contract; the future broadcast / reminder engine reads it.

### 12l.7 Branch isolation reuse

| Surface | Auth | Branch isolation |
|---|---|---|
| `/portal/*` | `careu_customer_session` | n/a — customer scope is enforced by `customer_id` match on every read |
| `/api/portal/*` | session cookie | response shape never leaks branch slugs of other branches |
| `/api/public/upload-url` | anonymous + rate-limited | branchCode validated against active branches; falls back to `no-branch/...` |
| `/api/portal/upload-url` | session cookie | branch resolved server-side from `customers.branch_id`; client cannot override |

---

## 12m. Customer communication layer (post-`20260536`)

> Status: **live**. SMS provider adapter, dispatch worker, customer phone-change flow, customer-facing audit timeline + photo gallery, browser upload helper. The customer portal is no longer "we'll wire SMS later" — outbound transactional messaging works end-to-end.

See [SMS_AND_DISPATCH.md](./SMS_AND_DISPATCH.md) for the operator runbook.

### 12m.1 SMS adapter

`lib/smsProvider.ts` — interface + console default + Twilio adapter, selected at runtime via `SMS_PROVIDER` env. `sendSms(input)` is the universal entry point used by OTP issuance, phone-change OTPs, and the dispatch worker's `dispatchSms`. Adapter cached for serverless function lifetime; `__resetSmsProviderCache()` exposed for tests.

### 12m.2 Dispatch worker

`lib/notificationDispatchWorker.ts::runDispatchTick(opts)` drains `customer_notifications`. Per-row state machine `queued → sending → (sent|failed-retryable|dead)`. Optimistic concurrency on the `status='queued'` flag prevents double-sends if two workers race. `MAX_ATTEMPTS=5`; exponential backoff (`60 × 3^(attempts-1)`s) capped at 3 h. Three triggers share the function:

```
/api/cron/dispatch-worker     ── Bearer CRON_SECRET                 (scheduled)
/api/admin/dispatch/run       ── requireRole(['owner','hq_admin'])  (manual)
/api/admin/dispatch/summary   ── requireRole(['owner','hq_admin'])  (read)
```

The admin-facing page `/admin/dispatch` consumes `summary` + `run` and surfaces queue depth, recent failures, and pending preview.

### 12m.3 Phone-change flow

```
/portal/phone-change
  ├─ request form → POST /api/portal/phone-change/request
  │   ├─ rate-limit 10/hr/IP + 3/hr/customer
  │   ├─ conflict check (no other customer owns new_phone)
  │   ├─ cancel older pending requests for this customer
  │   ├─ insert phone_change_requests row (hashed code, salt = row id)
  │   ├─ sendSms via SMS provider
  │   └─ audit: customer_activity {kind: 'phone_change_requested'}
  │
  └─ verify form → POST /api/portal/phone-change/verify
      ├─ rate-limit 20/10min/IP, 5-attempt cap per request
      ├─ expiry check (10 min TTL)
      ├─ RE-CHECK conflict at commit time (anti-takeover)
      ├─ UPDATE customers.phone + customers.normalized_phone
      ├─ stamp phone_change_requests.verified_at
      └─ audit: customer_activity {kind: 'phone_changed', payload: {from, to, ip}}
```

A unique partial index `phone_change_requests (new_phone) WHERE verified_at IS NULL AND cancelled_at IS NULL` enforces single-claim semantics at the DB layer. Session cookie carries `customerId`, not `phone`, so the existing portal session continues to work post-change — no re-login.

### 12m.4 Portal timeline + gallery

`/portal/orders/[id]` is now three sections deep:

| Section | Source | Filter |
|---|---|---|
| Summary (existing) | `GET /api/portal/orders/[id]` | handpicked customer-safe columns |
| Photo gallery | `GET /api/portal/orders/[id]/photos` | `order_attachments` filtered to `image/*` MIME, each row signed for 5-min read |
| Audit timeline | `GET /api/portal/orders/[id]/timeline` | `order_audit_log` filtered to four customer-safe actions: `created`, `status_changed`, `payment_changed`, `cancelled` |

All three routes hard-check `orders.customer_id === session.customerId` (same 404 enumeration-resistant pattern). Internal-only audit actions (`cost_updated`, `sync_pushed`, `sync_failed`, `assigned`, `receipt_regenerated`) are filtered server-side — the customer cannot see them even if they call the API directly.

### 12m.5 Upload client

`lib/uploadClient.ts::uploadFile` is the browser entry point. Compresses (canvas re-encode to JPEG @ 1920 px / 0.82 quality, HEIC/HEIF/GIF pass-through), fetches a signed URL via the existing route, PUTs with XHR-based progress events, retries transient failures (status 0/408/429/5xx) with exponential backoff. Untouched by any current page — drop-in upgrade for follow-up surfaces.

### 12m.6 Schema additions (`20260536`)

- `phone_change_requests` table + unique partial index for anti-takeover.
- `customer_notifications (channel, status)` index for the worker's per-channel scan.
- `customer_notifications (created_at DESC) WHERE status='failed'` index for the dispatch UI's recent-failures query.

### 12m.7 Branch isolation reuse

| Surface | Auth | Branch isolation |
|---|---|---|
| `/admin/dispatch` | owner / hq_admin | n/a — central admin view across branches |
| `/api/admin/dispatch/*` | `requireRole(['owner','hq_admin'])` | n/a — same |
| `/api/cron/dispatch-worker` | `Bearer CRON_SECRET` | n/a — machine endpoint |
| `/api/portal/orders/[id]/{timeline,photos}` | `careu_customer_session` | `customer_id === session.customerId` hard check (enumeration-resistant 404) |
| `/api/portal/phone-change/*` | `careu_customer_session` | per-customer rate-limit + DB-level anti-takeover |

---

## 12n. Customer engagement layer (post-`20260537`)

> Status: **live**. Lifecycle events queue real notifications. Customers control SMS/LINE/kind toggles via `/portal/preferences`. Portal polls for live status. Admin sees per-customer comms history + dispatch observability.

See [LIFECYCLE_NOTIFICATIONS.md](./LIFECYCLE_NOTIFICATIONS.md) for the operator runbook + cron wiring.

### 12n.1 Notifier flow

```
OPS UI / cron ──► /api/internal/lifecycle-event
                  ├─ requireRole + requireBranchAccess
                  └─ notifyLifecycleEvent(event, orderId)
                       ├─ load order + customer + prefs + LINE link
                       ├─ render via lib/notificationTemplates
                       ├─ dedup (6h window per kind+orderId+channel)
                       ├─ enqueueNotification × {sms, line}
                       └─ audit: order_audit_log.action='lifecycle_notified'

dispatch worker  ──► customer_notifications (queue, one row per intent)
                  ├─ runDispatchTick
                  │   ├─ writeDispatchLog × {sent | failed | skipped}
                  │   └─ retry with backoff
                  └─ notification_dispatch_log (append-only telemetry)

observability   ──► /api/admin/dispatch/summary
                  ├─ counts by status (queue)
                  ├─ aggregate over 24h dispatch_log
                  │   ├─ success rate %
                  │   ├─ avg retry depth
                  │   ├─ provider p50 / p95
                  │   └─ 24-bucket trend
                  └─ /admin/dispatch UI renders inline
```

### 12n.2 New tables

| Table | Purpose |
|---|---|
| `public.customer_notification_preferences` | Per-customer channel + kind toggles. Default opt-in transactional, opt-out promotional. |
| `public.notification_dispatch_log` | One row per dispatch ATTEMPT. Append-only. Source for the observability panel. |

### 12n.3 Templates

`lib/notificationTemplates.ts` — pure renderer. Per-kind function returns `{ sms, line }`. Branch branding via `BranchTemplateBrand`. Tier-aware honorific ("คุณ" for gold/platinum/VIP). No `{{var}}` templating — variables are typed at every call site.

### 12n.4 Preferences

`/portal/preferences` is a sectioned toggle UI: master channel toggles (SMS / LINE / email) + per-kind toggles (order status, pickup reminders, payment alerts, promotional). Each save writes a `prefs_changed` row to `customer_activity` with the diff. The lifecycle notifier consults this row at enqueue time so a customer who's opted out never sees their messages queue or count against retry quotas.

### 12n.5 Portal realtime

`lib/usePortalRefresh.ts` — visibility-aware polling hook (30 s default). Pauses when the tab is hidden, refreshes on `visibilitychange`, skips overlapping fetches. Used by `/portal/orders/[id]` so a customer who keeps the page open sees status changes within one tick of the OPS operator changing them.

### 12n.6 HEIC + EXIF orientation

`lib/uploadClient.ts::compressImageIfBeneficial` upgraded:
- `createImageBitmap(file, { imageOrientation: "from-image" })` auto-applies EXIF — no more sideways iPhone portraits.
- HEIC/HEIF: iOS Safari decodes natively → re-encodes to JPEG. Other browsers fail the decode → uploads raw bytes + sets `needsTranscoding: true` for a future Storage trigger.

### 12n.7 Admin customer view

`/admin/customers/[id]` aggregates everything we know about one customer: profile + lifecycle stage + retention score + tier + prefs + LINE link + recent orders (10) + activity (25) + notifications (15) + dispatch log (15) + upload count. Owner / HQ unrestricted; branch_manager / front_staff scoped by `requireBranchAccess(customer.branch_id)`. Read-only — no broadcast / send-from-admin button this phase.

### 12n.8 Branch isolation reuse

| Surface | Auth | Branch scope |
|---|---|---|
| `/api/internal/lifecycle-event` | operator role | `requireBranchAccess(order.branch_id)` |
| `/api/cron/overdue-pickup-sweep` | Bearer CRON_SECRET | n/a — machine endpoint |
| `/api/portal/preferences` | customer cookie | per-customer (own row only) |
| `/api/portal/activity` | customer cookie | per-customer (own row only) |
| `/api/admin/customers/[id]` | operator role | `requireBranchAccess(customer.branch_id)` |

---

## 12o. Communications maturity (post-`20260538`)

> Status: **delivery-aware**. Twilio status webhook verifies delivery. Per-customer rate limiter protects against spam loops. Operator resend / cancel / manual-send controls with full audit. HEIC transcode pipeline wired (transcoder pluggable).

See [SMS_AND_DISPATCH.md](./SMS_AND_DISPATCH.md) for the runbook.

### 12o.1 Expanded delivery state machine

```
queued ──► sending ──► sent ──► delivered    (Twilio webhook confirms)
                            └─► failed       (Twilio webhook says failed/undelivered)
                  └──► queued                (transient failure, backoff)
                  └──► dead_letter           (non-retryable OR attempts ≥ MAX_ATTEMPTS)
                  └──► skipped               (rate-limit / no recipient)
queued / sending ──► cancelled               (operator action)
```

`failed` (Phase 14+) is "transient, awaiting retry"; `dead_letter` is "out of the retry loop". Old pre-migration rows that landed in `failed` as terminal still show up in the admin dead-letter view.

### 12o.2 Twilio delivery webhook

`POST /api/webhooks/twilio-status` — signed by `X-Twilio-Signature`, verified with `TWILIO_AUTH_TOKEN`. Maps Twilio MessageStatus (`queued|sent|delivered|failed|undelivered`) to internal status with monotonic ordering — no downgrade ever applied. Join key is `provider_message_id` (the Twilio SID, captured by the dispatch worker from the send response).

### 12o.3 Per-customer rate limiter

`lib/customerRateLimit.ts::checkPerCustomerRateLimits` runs in the worker BEFORE each dispatch. Five buckets: same-kind cooldown (30 min), per-channel hour cap, per-channel day cap, total per-hour customer cap, total per-day order cap. Trips mark the row `skipped` with a structured reason; the observability panel counts triggers per bucket so operators can tune.

### 12o.4 Resend + cancel APIs

```
POST /api/admin/notifications/resend  → creates a new queue row with resent_from=original.id
POST /api/admin/notifications/cancel  → flips queued/sending row to status='cancelled'
POST /api/admin/notifications/send    → operator manual lifecycle send (force=true; bypasses 6h dedup)
```

All three audit into `notification_resend_log` with the operator id + reason + IP. The customer-facing `customer_activity` feed surfaces `notification_resent` / `notification_cancelled` rows so the customer can see "we re-sent this on Tuesday".

### 12o.5 HEIC transcode pipeline

`media_transcode_queue` table — populated by `/api/portal/upload-url` when an HEIC upload lands. `/api/cron/heic-transcode` drains it. The actual transcoder is a placeholder (`HEIC_TRANSCODER=stub`); the orchestration (status transitions, dead-letter, optimistic concurrency) is wired so swapping in `sharp+libheif` or a Supabase Edge Function is a single function replace.

### 12o.6 Dispatch observability extensions

`/admin/dispatch` Observability panel now shows:

- Success rate, retry depth, provider latency (carried over from Phase 13).
- **Resends (24h)** — total + breakdown by action.
- **Rate-limit triggers (24h)** — total + breakdown by bucket; turns amber when > 0.
- **Per-channel breakdown** (carried over).

KPI bar extended to 8 cards: queued / sending / sent / delivered / failed / dead_letter / skipped / cancelled.

### 12o.7 Branch isolation reuse

| Surface | Auth | Branch scope |
|---|---|---|
| `/api/admin/notifications/{resend,cancel,send}` | operator role | `requireBranchAccess(notification.branch_id)` |
| `/api/webhooks/twilio-status` | Twilio signature | n/a — vendor callback |
| `/api/cron/heic-transcode` | Bearer CRON_SECRET | n/a — machine endpoint |

---

## 12p. Broadcast foundation + segmentation (post-`20260539`)

> Status: **draft-only**. CRM operators can build segments, estimate audiences, draft templates, and preview cost. Mass-send remains intentionally out of scope.

See [CRM_BROADCAST.md](./CRM_BROADCAST.md) for the operator runbook.

### 12p.1 Schema (migration 20260539)

| Table | Purpose |
|---|---|
| `broadcast_drafts` | name + notes + channels + segment JSONB + per-channel templates. `status ∈ {draft, preview, archived}`. NEVER 'sent' this phase. |
| `broadcast_audience_snapshots` | computed counts cached per draft, history preserved. |
| `broadcast_audit_log` | append-only audit. Captures every state change. |
| `line_delivery_log` | LINE-side analogue of `notification_dispatch_log` — push acks + unfollow events. |

### 12p.2 New libraries

- `lib/crmSegmentationService.ts` — AND-combined filters → customer set + facet counts + sample. Caps customer fetch at 5000 to bound API cost.
- `lib/communicationPolicyService.ts` — `evaluatePolicy(ctx)` is the new authoritative gate (channel toggle → kind toggle → recipient presence → rate limit). Existing inline checks in the notifier + worker stay for now; new code (broadcast send, future) MUST call the policy service.
- `lib/heicTranscoder.ts` — sharp+libheif transcoder; produces JPEG + 320 px thumbnail siblings.

### 12p.3 APIs

```
GET    /api/admin/crm/broadcasts                — list drafts
POST   /api/admin/crm/broadcasts                — create draft
GET    /api/admin/crm/broadcasts/[id]           — fetch + latest snapshot
PATCH  /api/admin/crm/broadcasts/[id]           — update editable fields
DELETE /api/admin/crm/broadcasts/[id]           — archive (soft)
POST   /api/admin/crm/audiences/estimate        — compute counts; persists when draftId given
```

All require operator role + branch access. Owner / hq_admin have full scope; branch_manager is restricted to drafts whose branch_id is null or matches their branch. Front_staff / technician are denied.

### 12p.4 UI surfaces

- `/admin/crm/audiences` — standalone segment builder. Iterate filters, click "ประมาณการ", see counts + distribution + sample customers. No save.
- `/admin/crm/broadcasts` — draft list.
- `/admin/crm/broadcasts/[id]` — draft editor. "ส่ง broadcast" button explicitly disabled this phase.

### 12p.5 Promotional opt-in

Broadcast sends are treated as **promotional** for opt-in purposes. The audience estimator only counts customers whose `customer_notification_preferences.promotional === true`. Default is OFF — Thai opt-in norms.

### 12p.6 Real HEIC transcoder

`sharp` ships in deps. The cron `/api/cron/heic-transcode` now defaults to running the real transcoder (`HEIC_TRANSCODER=enabled` by default). Output paths: `<source>.jpg` + `<source>.thumb.jpg`. EXIF orientation auto-applied; metadata stripped.

### 12p.7 LINE delivery log

Two writers:
- Dispatch worker `dispatchLine` — `pushed` / `push_failed` per attempt.
- LINE webhook `processLineWebhookBody` — `unfollowed` when the user leaves the channel.

`/admin/customers/[id]` renders the most recent 15 rows so operators can answer "did LINE pushes ever reach this customer?".

### 12p.8 Branch isolation reuse

| Surface | Auth | Scope |
|---|---|---|
| All `/api/admin/crm/*` | operator role | `requireBranchAccess` per draft + scoped customer pool in segmentation |
| `crmSegmentationService.estimateAudience` | server-only | requires `scopedBranchCodes` from caller |
| `broadcast_drafts` RLS | per-policy | branch_manager limited to own branch via SQL policy |

---

## 12q. Broadcast send pipeline (post-`20260540`)

> Status: **send-capable**. Operators can run real broadcasts with pause/resume/cancel + scheduling + cross-draft dedup + quiet hours. Single-branch default; cross-branch sends require an explicit feature-flag flip.

See [CRM_BROADCAST.md §10](./CRM_BROADCAST.md) for the operator runbook.

### 12q.1 New schema

| Table | Purpose |
|---|---|
| `broadcast_send_jobs` | per-send-action row. Frozen segment + templates. `status ∈ {queued, processing, paused, completed, cancelled, failed}`. `mode ∈ {live, dry_run}`. |
| `broadcast_send_targets` | per (job, customer, channel). UNIQUE on the triple — fan-out is restart-safe. |
| `broadcast_send_attempts` | append-only log of cron ticks per job. |
| `broadcast_metrics_daily` | aggregated per (job, channel, date). |
| `feature_flags` | server-side toggles (sms / line / scheduled / cross-branch / caps / hours / dedup). |

### 12q.2 Flow

```
operator → POST /send (live | dry_run | scheduled)
        → INSERT broadcast_send_jobs status=queued

cron /api/cron/broadcast-send
  └─ runBroadcastSendTick (jobLimit=5, chunk=50)
       ├─ checkSchedule + checkQuietHours
       ├─ first run → fan-out (UPSERT targets, restart-safe)
       ├─ per-target: isChannelEnabled → evaluatePolicy
       │              → isRecentlyBroadcasted → enqueueNotification
       ├─ refresh broadcast_metrics_daily
       └─ mark completed when no pending rows
```

The existing dispatch worker drains `customer_notifications` rows the fan-out creates — provider send + retry + dead-letter all reuse the proven path from Phase 12–14.

### 12q.3 Operator controls

- `POST /api/admin/crm/broadcasts/[id]/send` — create a send_job. Validates audience cap + cross-branch flag + channel flags + scheduling flag.
- `PATCH /api/admin/crm/broadcasts/[id]/jobs/[jobId] { action: pause|resume|cancel }` — state transitions. Cancel sets all pending targets to skipped.
- `GET /api/admin/crm/broadcasts/[id]/jobs/[jobId]` — counts + breakdown + attempts + metrics + sample.
- `GET /api/admin/crm/broadcasts/[id]/jobs` — job list per draft.

### 12q.4 Cross-draft dedup

Sliding window from `broadcast_dedup_window_hours` (default 24 h). Checked at fan-out time per target. "Newest wins" via the natural temporal ordering — older jobs see newer-dispatched rows and skip.

### 12q.5 Quiet hours

Default 09:00–19:00 Bangkok. Bangkok hour resolved via `Intl.DateTimeFormat({ timeZone: "Asia/Bangkok" })`. Outside the window the cron tick is a no-op + writes a `broadcast_send_attempts` row with `blocked_reason`. Operator-configurable via `broadcast_quiet_hours_{start,end}_h` flags.

### 12q.6 Feature flags

`lib/featureFlags.ts` reads `public.feature_flags`, caches per-function-lifetime (60 s TTL), falls back to hard-coded defaults when the table is unreachable. Branch-scoped overrides supported.

**Defaults (inserted by `20260540`):**
- `enable_cross_branch_broadcasts = false` — single-branch is the production-safe default.
- `broadcast_max_targets_per_job = 2000` — hard cap.
- All other flags default to "feature on" + sensible window/cap values.

### 12q.7 Branch isolation

| Surface | Auth | Scope |
|---|---|---|
| `POST /api/admin/crm/broadcasts/[id]/send` | operator role | `requireBranchAccess(draft.branch_id)` + cross-branch flag check |
| `GET/PATCH /api/admin/crm/broadcasts/[id]/jobs/[jobId]` | operator role | `requireBranchAccess(job.branch_id)` |
| `GET /api/admin/crm/broadcasts/[id]/jobs` | operator role | `requireBranchAccess(draft.branch_id)` |
| `runBroadcastSendTick` | server-only | scoped customer fetch via `job.branch_id` |
| `/api/cron/broadcast-send` | Bearer CRON_SECRET | n/a — machine endpoint |

---

## 12r. Worker telemetry + self-heal (post-`20260541`)

> Status: **observable**. Every cron writes a heartbeat. Dashboard surfaces queue depth, stuck jobs, cron silence, alert breaches. One-click self-heal unlocks stale rows. Email channel foundation in place.

See [WORKER_TELEMETRY.md](./WORKER_TELEMETRY.md) for the operator runbook.

### 12r.1 New schema

| Table | Purpose |
|---|---|
| `cron_heartbeat_logs` | append-only, one row per cron invocation. |
| `communication_alert_rules` | operator-defined thresholds. 5 metric kinds × 2 comparisons × per-branch scope. |
| `feature_flags` (PK fix) | now uniquely keyed on `(key, branch_id)` via partial indexes, enabling per-branch overrides to coexist with global rows. |

### 12r.2 New libraries

- `lib/cronHeartbeat.ts` — `withCronHeartbeat(cronName, handler)` wraps every cron handler. Best-effort logging; re-throws on failure.
- `lib/workerHealth.ts` — aggregates heartbeats + queue scan + alert evaluation into one snapshot. Three "stuck" detectors: cron silence, queue stall, sending stall.
- `lib/channels/email/index.ts` — `EmailProvider` interface + console default + Resend placeholder.

### 12r.3 New routes

| Route | What |
|---|---|
| `GET /api/admin/system/workers` | telemetry snapshot |
| `POST /api/admin/system/recover-workers` | self-heal (owner/HQ, 5/10min/IP) |
| `GET/POST /api/admin/system/alert-rules` | rule CRUD |
| `GET/POST /api/admin/settings/communications` | per-branch flag management |

### 12r.4 UI surfaces

- `/admin/system/workers` — full dashboard. Per-cron table, queue KPIs, active alerts, self-heal button. Polls every 30 s.
- `/admin/settings/communications` — per-branch toggle UI. Save invalidates the in-process cache.
- `components/WorkerHealthBanner.tsx` — embedded on `/admin` + `/admin/dispatch`. Auto-hides when healthy; auto-shows on warning/critical; 30-min session dismiss.

### 12r.5 Email channel

`customer_notifications.channel='email'` is now drained by the dispatch worker (`dispatchEmail`). `payload.{email, subject, body}` required. Default provider logs to console; flipping `EMAIL_PROVIDER=resend` + setting `RESEND_API_KEY` + `EMAIL_FROM` activates the real adapter.

### 12r.6 Unified communications timeline

`/admin/customers/[id]` interleaves `customer_notifications` + `notification_dispatch_log` + `line_delivery_log` into one chronological feed (30 most recent). The three structured tables remain for operators who prefer the columnar view.

### 12r.7 Branch isolation

| Surface | Auth | Scope |
|---|---|---|
| All `/api/admin/system/*` | owner / hq_admin | system-wide |
| `/api/admin/settings/communications` | owner / hq_admin | writes per-branch override rows |
| `feature_flags` SELECT RLS | authenticated | read open; writes admin-only |

---

## 12s. Engagement intelligence + retention triggers (post-`20260542`)

> Status: **live**. Nightly lifecycle classifications, hourly retention triggers, versioned email templates, branch-scoped engagement dashboard.

See [ENGAGEMENT_INTELLIGENCE.md](./ENGAGEMENT_INTELLIGENCE.md).

### 12s.1 New schema

| Table | Purpose |
|---|---|
| `customer_engagement_daily` | per (customer, date) snapshot — order/spend/comms/cancellation counts. |
| `customer_lifecycle_status` | current 7-state classification + reason + previous_status + changed_at. |
| `retention_trigger_jobs` | audit row per trigger fire. Dedup keys + fired_reason. |
| `email_templates` | live template content with `current_version`. |
| `email_template_versions` | immutable history. INSERT/SELECT-only RLS. |

### 12s.2 Libraries

- `lib/customerLifecycle.ts` — pure classifier with explainable reason. 7 statuses: new/active/repeat/loyal/at_risk/dormant/churned.
- `lib/engagementMetricsService.ts` — nightly aggregator. Reads customers + counts comms from `customer_notifications` and cancellations from `orders`. Idempotent UPSERTs.
- `lib/retentionTriggerService.ts` — 6 trigger kinds with per-kind dedup window, communication policy gate, quiet-hours guard. Single-customer dispatch via the existing dispatch worker.
- `lib/emailTemplateService.ts` — render + interpolation + version save + restore. Restore re-snapshots first so history is always monotonic.

### 12s.3 Cron entry points (added to `CronName` enum)

| Endpoint | Cadence |
|---|---|
| `/api/cron/engagement-aggregate` | daily |
| `/api/cron/retention-triggers` | hourly |

Both wrapped via `withCronHeartbeat` — appear in the Phase 17 workers dashboard automatically.

### 12s.4 Engagement dashboard

`/admin/crm/engagement` reads `/api/admin/crm/engagement`:

- 7 KPI cards by status.
- 30-day retention trend (total vs. repeat customers per day).
- Churn risk count + top 15 returning customers.
- 24h retention-trigger summary per kind (fired/skipped/failed).
- Branch comparison stacked table (owner/HQ).

Branch_manager sees their own branch only via the customer pool filter.

### 12s.5 Template management

`/admin/communications/templates` — list + create.
`/admin/communications/templates/[id]` — edit + live preview + test-send + version history with one-click restore.

Test-send routes through the channel adapter directly — bypasses queue + preferences (operator wants immediate feedback). Rate-limited 10/10min/IP.

### 12s.6 Segmentation extensions

Phase 15's `SegmentDefinition` gains 5 new filters: `lifecycleStatuses`, `totalSpendLte`, `totalOrdersLte`, `dormantDaysGte`, `branchAffinityOnly` (placeholder). The `lifecycleStatuses` filter joins to `customer_lifecycle_status` post-fetch so existing Phase 15 indices stay valid.

### 12s.7 Branch isolation

| Surface | Auth | Scope |
|---|---|---|
| `customer_lifecycle_status` / `_daily` RLS | role + branch_id | enforced |
| `retention_trigger_jobs` RLS | role + branch_id | enforced |
| `email_templates` RLS | full write owner/HQ; read scoped for branch_manager | enforced |
| `/api/admin/crm/engagement` | role + branch_manager scoped customer pool | enforced |
| `runRetentionTriggerTick` | server-only | currently global — per-branch overrides on the roadmap |

---

## 12t. Engagement feedback loop (post-`20260543`)

> Status: **closed loop**. Per-branch trigger overrides, optional DOB capture, block-composable HTML email, signed click+open tracking, Resend webhook, campaign→order attribution, per-channel performance aggregator, per-branch customer unsubscribe.

See [ENGAGEMENT_FEEDBACK_LOOP.md](./ENGAGEMENT_FEEDBACK_LOOP.md).

### 12t.1 New tables

- `branch_trigger_overrides` — per-branch threshold rows; falls back to HQ defaults via `lib/branchTriggerOverrides.ts`.
- `customers.birth_date` + `birth_month_verified` — optional DOB columns. Activates Phase 18's birthday trigger.
- `communication_events` — append-only customer-side event stream (delivered/opened/clicked/bounced/complained/unsubscribed/failed). Replay-safe via unique (provider, provider_event_id).
- `customer_branch_unsubscribes` — per (customer, branch, channel, scope) opt-out. Layered above Phase 13 global prefs.
- `campaign_response_metrics` — attribution rows; 14-day window; unique (source_kind, source_id, customer_id).
- `communication_performance_daily` — per (branch, channel, date) aggregated metrics.

### 12t.2 New libraries

- `lib/branchTriggerOverrides.ts` — resolveNumber/resolveBoolean with branch → DEFAULTS → fallback ordering. 60s cache.
- `lib/communicationEvents.ts` — `recordCommunicationEvent(input)` + `maybeApplyDeliveryStatus`. IP hashed at insert. Dedup via provider_event_id unique.
- `lib/trackingLinks.ts` — HMAC-SHA256 signed tokens with TTL. `buildClickUrl` + `buildOpenPixelUrl`. `verifyTrackingToken` constant-time.
- `lib/campaignAttribution.ts` — `attributeOrderToCampaign({...})`. 14-day lookback. Reads current lifecycle to flag recovered_dormant.
- `lib/commPerformanceAggregator.ts` — nightly per (branch, channel, date) UPSERT into `communication_performance_daily`.
- `lib/email/renderers/blocks.ts` — 7 composable block types.
- `lib/email/renderers/layout.ts` — 600px responsive shell + plain-text fallback.

### 12t.3 Tracking + webhook routes

- `GET /api/track/click?t=...` — HMAC verify → record event → 302 redirect. Bad/expired → fallback redirect + forensic log.
- `GET /api/track/open?t=...` — HMAC verify → record event → 1×1 GIF. Always returns 200 to keep email clients happy.
- `POST /api/webhooks/email-status` — Svix-signed Resend webhook receiver. Updates `customer_notifications.status` on delivered/failed (monotonic).

### 12t.4 Policy integration

- `lib/customerLifecycle.ts::classifyLifecycle({...}, overrides)` accepts `atRiskDays` + `dormantDays`. Engagement aggregator resolves per-branch values before calling.
- `lib/communicationPolicyService.ts::evaluatePolicy` accepts `branchId` in context. For promotional intent, checks `customer_branch_unsubscribes` after global prefs. Bucket = `branch_unsubscribed`.
- `lib/broadcastSendWorker.ts` + `lib/retentionTriggerService.ts` now pass `branchId` into `evaluatePolicy`.

### 12t.5 Dashboard + explainability

- `/admin/crm/engagement` (Phase 18) extended with Campaign ROI (30d) + Comms performance (30d) sections.
- `/admin/crm/triggers` new — explainability list of retention_trigger_jobs with status / kind filters. Every row shows `fired_reason` + `skip_reason`.

### 12t.6 Customer portal additions

- `/portal/profile` adds DOB editor (set / clear; flips `birth_month_verified`).
- Per-branch unsubscribe list section with re-subscribe buttons.
- `/api/portal/unsubscribe` (GET/POST/DELETE) — customer manages their own branch unsubscribes.

### 12t.7 Branch isolation

| Surface | Auth | Scope |
|---|---|---|
| `branch_trigger_overrides` RLS | role + branch_id | enforced |
| `communication_events` RLS | role + branch | enforced |
| `customer_branch_unsubscribes` RLS | role + branch | enforced |
| `campaign_response_metrics` RLS | role + branch | enforced |
| `communication_performance_daily` RLS | role + branch | enforced |
| `/api/admin/crm/triggers` | role + branch_id filter | enforced |
| `/api/portal/unsubscribe` | customer cookie | per-customer (own rows) |
| `evaluatePolicy` per-branch unsubscribe | server-side | enforced |

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
├── api/public/upload-url/route.ts            ← Anon signed PUT URL for quote photos
├── api/portal/auth/request-otp/route.ts      ← Customer OTP issue
├── api/portal/auth/verify-otp/route.ts       ← Customer OTP verify + mint cookie
├── api/portal/auth/me/route.ts               ← Current customer session
├── api/portal/auth/logout/route.ts           ← Clear customer cookie
├── api/portal/orders/route.ts                ← Customer order list (narrow projection)
├── api/portal/orders/[id]/route.ts           ← Customer order detail (owner check)
├── api/portal/profile/route.ts               ← GET + PATCH customer profile
├── api/portal/upload-url/route.ts            ← Authenticated signed PUT URL
├── (public)/layout.tsx                       ← Public-website route group layout
├── (public)/website/page.tsx                 ← Public marketing landing
├── (public)/branches/page.tsx                ← Active branches grid
├── (public)/branches/[branchCode]/page.tsx   ← Single-branch detail with brand theme
├── (public)/services/page.tsx                ← Catalog grouped by category
├── (public)/track/page.tsx                   ← Customer job tracking form
├── (public)/quote/page.tsx                   ← Quote-request form
├── (public)/about/page.tsx                   ← Static brand story
├── (public)/contact/page.tsx                 ← Contact options
├── (public)/portal/layout.tsx                ← Customer portal layout
├── (public)/portal/page.tsx                  ← Portal dashboard (signed-in home)
├── (public)/portal/signin/page.tsx           ← Phone + OTP sign-in
├── (public)/portal/orders/page.tsx           ← All orders list
├── (public)/portal/orders/[id]/page.tsx      ← Order detail (customer-safe)
├── (public)/portal/profile/page.tsx          ← Self-edit name + email
├── (public)/portal/history/page.tsx          ← Completed / ready / cancelled
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
├── rateLimit.ts          ← in-memory token bucket for /api/public/* + /api/portal/*
├── publicTheme.ts        ← BRAND_THEMES + themeForBranch for the customer-facing website
├── customerSession.ts    ← HMAC customer cookie codec (careu_customer_session)
├── customerOtp.ts        ← OTP issue / verify (hashed; universal dev code 123456)
├── customerIdentityResolver.ts ← resolveByPhone / Line / findOrCreateByPhone / merge stub
├── crmProgressionService.ts ← calculateLifecycleStage + calculateRetentionScore + refresh
├── notificationService.ts ← enqueueNotification + read helpers
└── uploadService.ts      ← issueUploadUrl + issueReadUrl against customer-uploads bucket

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

**Last updated:** 2026-05-14 (customer portal + uploads + CRM progression — `app/(public)/portal/*`, `/api/portal/*`, `lib/customerOtp.ts`, `lib/uploadService.ts`, `lib/crmProgressionService.ts`, `20260535` migration, new `CUSTOMER_PORTAL.md` + `UPLOADS.md`)
