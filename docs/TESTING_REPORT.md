# CareU OPS Platform — Operational Testing Report

> **Phase:** End-to-end operational testing + bug sweep (post-`2026-05-14`).
> **Scope:** static code review against realistic storefront workflows; no live database was exercised. Findings are categorised by severity with file:line evidence.

---

## 1. Operational test summary

I walked the following workflows end-to-end in code (all 5 roles unless noted):

| Workflow | Status | Notes |
|---|---|---|
| LINE login → cookie → role/branch hydration | ✅ works | First-user bootstrap as `owner` confirmed in `app/api/auth/line/callback/route.ts`. JWT bridge mint + proactive refresh in `lib/authContext.tsx`. |
| Customer search (`SmartOrderForm`) | ✅ works | Phone normalisation in `lib/phone.ts`; auto-select on exact 9-10 digit match. |
| Create order — Care U (manual Job ID) | ✅ works | Race-safe via DB unique partial index; app pre-check + insert-time fallback in `lib/orderCreate.ts:121-126,230-236`. |
| Create order — Ezy (auto Job ID) | ✅ works | Atomic RPC `generate_ezy_job_id(branch_id)` — concurrency-safe. |
| Pricing calculation (base + urgent + B2S discount) | ✅ works | Tiered B2S logic in `lib/pricing.ts::computeDiscount`. Manual override is intentional per design. |
| Order → Google Sheet sync | ⚠ **broken in strict mode** before this commit — see Bug #1. **Fixed in this commit.** |
| Status flow `pending → in-progress → completed → ready-for-pickup` | ✅ works | DB CHECK constraint in `20260526` enforces canonical values; UI dropdown limits choices. |
| Receipt generation (A4 / Thermal / Mobile) | ✅ works | `lib/receiptData.ts` builders match `total = subtotal + urgent_fee − discount` consistently. Fallback math verified correct. |
| Payment status update | ✅ works | RLS allows owner / hq_admin / branch_manager / front_staff to write. |
| LINE OA send (4 message kinds) | ⚠ cross-branch leak before this commit — see Bug #2. **Fixed in this commit.** |
| Dashboard KPI hydration | ✅ works | `fetchDashboardSnapshot` + `assembleKpis` route through the new data + KPI layers cleanly. |
| Audit log writes | ✅ works | Order audit best-effort; pricing + expense audits via DB trigger (impossible to forget). |
| Branch isolation (RLS strict policies) | ✅ works | Verified that `current_user_branch_code()` returns NULL for anon, denying all reads. |

## 2. Bug list

### CRITICAL

#### Bug #1 — `/api/sync-order-to-sheet` is non-functional in strict mode + had no auth

- **File:** [app/api/sync-order-to-sheet/route.ts](../app/api/sync-order-to-sheet/route.ts)
- **Reproduce:** Apply migration `20260522_auth_bridge_rls.sql`, set `SUPABASE_JWT_SECRET`. Create an order via `/intake`. Browser fires POST `/api/sync-order-to-sheet`. Route responds **404 "ไม่พบใบงานในระบบ"** for every order.
- **Cause:** The route imported the browser-side `supabase` singleton (`lib/supabase.ts`). The bridge-JWT fetch interceptor only fires after `setBridgeJwt()` is called, which only happens in the browser AuthProvider. In a Node API context, queries went out with `Authorization: Bearer <anon_key>`, so PostgREST evaluated RLS as `anon` and returned 0 rows. Compounding the issue: the route had **no `requireRole`** at all.
- **Impact:** Order auto-sync to the `Front_Desk` Google Sheet tab — used by accounting for daily reconciliation — silently failed for every new order. Manual retry from `/orders/[id]/document` also failed.
- **Fix (this commit):** Replaced the anon read with `getSupabaseAdmin()`; added `requireRole(['owner','hq_admin','branch_manager','front_staff','technician'])` at the top; added `requireBranchAccess(order.branch_id)` after fetching the order so branch-scoped roles can't sync foreign-branch orders.

#### Bug #2 — `/api/line/send` allowed cross-branch LINE notifications

- **File:** [app/api/line/send/route.ts](../app/api/line/send/route.ts)
- **Reproduce:** Sign in as a `front_staff` at Branch A. POST `/api/line/send` with `{ orderId: <Branch_B_order>, kind: 'order_ready' }`. The role gate passes, the orchestrator in `lib/lineDelivery.ts` reads the order via the **service-role client (bypassing RLS)**, and a LINE message gets pushed for a customer outside the caller's branch.
- **Cause:** The route only called `requireRole(...)`. No branch ownership check. Service-role read in the orchestrator means RLS isn't a second gate either.
- **Impact:** Privacy/PDPA risk — a staff member in one branch could probe order ids and trigger LINE notifications for another branch's customers.
- **Fix (this commit):** After parsing the orderId, the route now loads `orders.branch_id` via the admin client and calls `requireBranchAccess(orderBranchCode)` before invoking the orchestrator. Owner / hq_admin pass through automatically; branch-scoped roles get 403 for foreign-branch orders.

### HIGH

#### Bug #3 — JWT bridge unset silently returns empty data

- **File:** [lib/supabaseJwt.ts:34-43](../lib/supabaseJwt.ts), [lib/authContext.tsx:111-112](../lib/authContext.tsx)
- **Reproduce:** Apply migration `20260522`, deploy without setting `SUPABASE_JWT_SECRET`. Sign in. Every RLS-protected page (`/orders`, `/customers`, `/expenses`, `/`) shows zero data with no error.
- **Cause:** `mintSupabaseJwt()` returns null when the secret is missing/too short. `setBridgeJwt(null)` causes the supabase client to run as anon → RLS denies every read.
- **Impact:** Operator perceives a regression ("our data disappeared") with no diagnostic surface. /api/auth/me returns `jwtBridgeConfigured: false` but nothing in the UI showed it.
- **Fix (this commit):** Added [components/AuthHealthBanner.tsx](../components/AuthHealthBanner.tsx), mounted in `app/layout.tsx`. Renders a red banner whenever `authRequired && isAuthenticated && !jwtBridgeConfigured`. Hidden on `/login` and in preview mode.

### MEDIUM

#### Bug #4 — Sidebar branch lock falls through when `user.branchId` is null

- **File:** [components/Sidebar.tsx:64-68](../components/Sidebar.tsx)
- **Reproduce:** A profile row with `branch_id IS NULL` for a non-admin role (rare but possible if SQL-promoted a user without setting branch).
- **Cause:** `b.id === (user.branchId ?? branch.id)` — if `user.branchId` is null the filter uses the currently-selected `branch.id`, which defaults to `defaultBranch` from brandConfig. The dropdown is disabled, but the visual "current branch" misrepresents reality.
- **Impact:** Cosmetic in strict mode (RLS still returns 0 rows because `current_user_branch_code()` is also null). Confusing UX though.
- **Recommended fix priority:** MEDIUM. Either (a) reject login for branch-scoped roles with null `branch_id` in the auth callback, or (b) render an explicit "your account has no branch — contact admin" panel in `RouteGuard`.

#### Bug #5 — `customer_tier` / `total_orders` / `latest_service` columns never written

- **File:** schema in `20260521_enterprise_foundation.sql`; no writer in code.
- **Cause:** Columns scaffolded for a future maintenance trigger that hasn't shipped.
- **Impact:** Any future report that reads these columns will see stale/null data. Today nothing reads them, so the impact is latent.
- **Recommended fix priority:** MEDIUM — either add a trigger that recomputes on order insert/update, or drop the columns until the maintenance phase ships. Documented as a next-phase item.

#### Bug #6 — Sync failure kind misclassified for LINE pushes

- **File:** [lib/lineDelivery.ts:206-213](../lib/lineDelivery.ts)
- **Cause:** When a LINE push fails, the orchestrator calls `logSyncFailure({ kind: 'order_to_sheet', ... })` — the comment acknowledges it's "the closest existing kind". A future cron retry that filters by `kind='order_to_sheet'` would mistakenly retry LINE failures by posting them to the Google Sheet sync route.
- **Impact:** Today there's no retry worker, so latent. A retry worker built next phase would misroute.
- **Recommended fix priority:** MEDIUM — extend the `sync_failures.kind` CHECK constraint to include `'line_send'` and update the orchestrator. One small migration.

### LOW

#### Bug #7 — Duplicate Job ID feedback is post-submit, not live

- **File:** [lib/orderCreate.ts:121-126](../lib/orderCreate.ts), `components/SmartOrderForm.tsx`
- **Cause:** Care U manual Job ID validation runs server-side on submit. The DB unique partial index is the real guard.
- **Impact:** Staff types an in-use id, fills the form, clicks save, then gets a friendly error and retries. ≤ 10s delay; not data-corrupting.
- **Recommended fix priority:** LOW. A debounced async existence check on the Job ID input would shave a step but isn't required for safe operation.

#### Bug #8 — `/orders` and `/customers` client queries omit explicit branch filter

- **Files:** [app/orders/page.tsx:74-78](../app/orders/page.tsx), [app/customers/page.tsx:96-114](../app/customers/page.tsx)
- **Cause:** Both queries rely entirely on RLS to scope. In strict mode this works. In preview mode they leak — but preview mode is documented as no-security.
- **Recommended fix priority:** LOW — add a belt-and-braces `.eq("branch_id", branch.id)` for branch-scoped roles. Defence in depth, not a bug.

#### Bug #9 — Customer dedup uses global phone, no branch in the dedup key

- **File:** [lib/customerImport.ts:108-124](../lib/customerImport.ts)
- **Cause:** Import fetches `select("phone")` without a branch filter. In strict mode RLS scopes the read to the caller's branch (+ globals), so dedup is correct against those. Owner/hq_admin sees all branches and would dedup across them.
- **Recommended fix priority:** LOW — current behaviour is acceptable; document the dedup model on the import modal so admins running cross-branch imports know.

## 3. Performance observations

Not blockers, documented for the optimisation phase:

| Hotspot | File | Observation |
|---|---|---|
| Customer list refetches stats on every `customers` change | `app/customers/page.tsx:177-183` | An effect that depends on `customers` re-runs `fetchCustomerStats(customers)` on every reload. For small N this is fine; > 500 customers it round-trips the full orders table. |
| Orders list pulls all rows | `app/orders/page.tsx:74-78` | No pagination. Acceptable for ~1000 rows/branch; pre-emptive paging will be needed at scale. |
| Dashboard fetches full orders array | `lib/dashboardData.ts` | Already a documented next-phase swap to a materialised view. |
| Pricing catalog re-fetches on every page load | `app/pricing/page.tsx:144-176` | Cache via SWR/TanStack Query in a future phase. |
| `/admin/staff` joins profiles ⋈ branches ⋈ technician_profiles | `lib/staffService.ts` | One round trip thanks to embedded select; fine for ≤ 200 staff. |

No expensive React renders identified. Re-renders are scoped by `useMemo` filters.

## 4. Production readiness assessment

| Area | Status | Notes |
|---|---|---|
| Auth (LINE login + HMAC cookie) | ✅ ready | TTL refresh + JWT bridge wired correctly. |
| RLS on orders / customers | ✅ ready | Strict policies confirmed in `20260522`. |
| Order intake (Care U + Ezy) | ✅ ready | Race-safe Job ID. |
| Status workflow + audit | ✅ ready | DB CHECK constraints + best-effort audit writes. |
| Pricing catalog | ✅ ready | Versioned + audit-triggered. |
| Receipt rendering + print | ✅ ready | A4 + thermal + mobile templates. |
| Google Sheet sync (after this commit) | ✅ ready | Bug #1 fixed; auth + branch guards in place. |
| LINE OA send (after this commit) | ✅ ready | Bug #2 fixed; orchestrator branch-checked. |
| Admin/staff foundation | ✅ beta | Functional but the supabase anon client + bridge JWT path needs more field testing. |
| Sync recovery UI | ⚠ stub only | `lib/recoveryService.ts` exists, `/admin/recovery` page does not. |
| LINE follow webhook | ⚠ next-phase | Customer-side LINE linking is admin-SQL only today. |
| Payroll UI | ⚠ next-phase | Data layer ready, UI deferred. |
| Materialised dashboard view | ⚠ next-phase | Current `fetchDashboardSnapshot` is acceptable up to ~500 orders/branch/month. |
| Customer tier maintenance trigger | ⚠ next-phase | Columns exist, writer doesn't. |

## 5. Recommended next phase

1. **Sync recovery UI** — `/admin/recovery` reading `public.sync_failures`. Buttons: retry (calls `resyncOrderToSheet`), mark resolved. Already-built data layer in `lib/recoveryService.ts`.
2. **Extend `sync_failures.kind` CHECK** to add `'line_send'`, fix orchestrator (Bug #6).
3. **Maintenance trigger** for `customers.total_orders / latest_service / customer_tier` (Bug #5).
4. **Live Job ID validation** on the intake form (Bug #7).

Everything beyond those four sits comfortably in the franchise-readiness / scaling band (materialised dashboard view, LINE follow webhook, payroll UI, broadcast / segmentation).

## 6. Known risks before real multi-branch rollout

| Risk | Mitigation |
|---|---|
| Operator deploys without setting `SUPABASE_JWT_SECRET` | New red banner from this commit catches it. Add to deploy checklist. |
| Operator forgets to run `20260522` after setting JWT bridge | Pages return data via anon — same banner does NOT fire (because the bridge IS configured). Add a smoke-test: after deploy, owner logs in and confirms `/orders` shows at least one row. |
| Branch-scoped staff is granted access without `profiles.branch_id` set | Bug #4 — UI shows default branch with disabled select; data appears empty. Until that's fixed, audit profile rows in SQL after promotion. |
| Two branches share a customer phone — Care U vs Ezy Repair | Today dedup is per-branch in strict mode (RLS scopes the read). Owner-side bulk import could collapse them; train admins. |
| Sync failures accumulate without a retry worker | Future cron retry from `lib/recoveryService.ts`. Until then, manually `select * from public.sync_failures` once a week. |
| LINE channel token rotation | `branch_line_configs.channel_access_token` is service-role-only. Rotation script needs admin SQL access; document in OPS runbook. |
| Service-role key leakage | Only used in server route handlers via `getSupabaseAdmin()`; never imported from `"use client"` files. Re-verified for routes touched this phase. |

---

## Appendix — fixes shipped in this commit

- **app/api/sync-order-to-sheet/route.ts** — `requireRole` + service-role read + `requireBranchAccess`. Sync now works in strict mode and refuses cross-branch sync.
- **app/api/line/send/route.ts** — Branch ownership re-check before orchestrator invocation. Refuses cross-branch LINE sends with 403.
- **components/AuthHealthBanner.tsx** — Red banner when `authRequired && isAuthenticated && !jwtBridgeConfigured`. Mounted from `app/layout.tsx`.

Build verified clean (`pnpm build` → 19/19 routes generated).

**Last updated:** 2026-05-14 (operational testing + bug sweep phase)
