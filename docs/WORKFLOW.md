# CareU OPS Platform — Business Workflows

> **Status:** permanent reference. These flows describe what the platform must do, end-to-end, for each business and each role.

---

## Glossary

| Term | Meaning |
|---|---|
| **Order / Job** | One repair / alteration unit of work. Stored as a row in `public.orders`. |
| **Job ID** | Human-readable identifier the customer sees on the receipt (e.g. `SLM-260513-001` or `CARE-241`). |
| **Branch** | Physical shop location. Row in `public.branches`. |
| **Brand** | `careu` or `ezy` — set on the branch row, used for UI accent and routing logic. |
| **Business type** | `care_u` or `ezy_repair` — set on each order. Drives job-id strategy. |

---

## 1. Care U flow (clothing alteration)

> Care U = walk-in clothing alteration. The customer drops off garments, gets a written quote + receipt, and picks up the work later.

### 1.1 Receive order (front-desk)
1. Front-desk staff opens `/intake` on tablet.
2. **Section 0 — Business type**: defaults to `Care U` when current branch's brand is `careu`. Staff may switch to Ezy Repair manually.
3. Branch selector is locked unless the user is `owner` / `hq_admin`.

### 1.2 Customer lookup
1. Staff types phone / name into the customer field.
2. `SmartOrderForm` filters `customers` by:
   - exact normalized phone (9–10 digits) → auto-select.
   - substring match on name or phone (top 6 suggestions).
3. If no match → "+ เพิ่มลูกค้าใหม่" creates a new `customers` row keyed by `branch_id` + `phone`.
4. If two staff hit the same new customer at the same time, the dedup helper in `lib/customerImport.ts` collapses them by `normalized_phone`.

### 1.3 Pricing
1. Staff picks a category and a service from the dropdown. The catalog comes from `service_prices` (DB-first) with `lib/pricing.ts::SERVICES` as fallback — see [PRICING_RULES.md](./PRICING_RULES.md).
2. Template text + base price auto-fill. Staff can edit either.
3. Quantity defaults to 1.

### 1.4 Urgent queue ("คิวงานด่วน")
1. Toggle the **งานด่วน** checkbox.
2. Quick presets `+30` and `+50` from `URGENT_MODIFIERS`, plus a freeform input.
3. The selected service's `urgent_fee_default` (when present on the DB row) pre-fills this field.
4. The fee shows as a separate line on the receipt — never folded into the base price.

### 1.5 BTS / Back to School promotion
1. Promotion dropdown → pick `B2S`.
2. The discount applies according to the **tiered** Back to School rule in [PRICING_RULES.md](./PRICING_RULES.md) (200–299 → 20, 300–499 → 30, 500–999 → 50, 1000+ → 100).
3. Excluded items: student name embroidery. The form does not enforce this today — front-desk staff must apply judgment until the rule lands in `computeDiscount`.

### 1.6 Job ID (manual)
1. Section 5 shows a **manual** input — Care U is manual-only ([JOB_ID_RULES.md](./JOB_ID_RULES.md)).
2. Staff types the id (e.g. `CARE-241`).
3. On submit, `createSmartOrder` checks uniqueness scoped to `(branch_id, business_type='care_u', job_id)`. Duplicate → instant error in red banner.

### 1.7 Save + receipt
1. Press "บันทึกใบงาน".
2. `createSmartOrder` inserts into `orders` with `business_type='care_u'`, `job_id=<manual>`, `created_by=session.uid`.
3. Audit row written: `order_audit_log(action='created', after_value=job_id, changed_by=session.uid)`.
4. Browser navigates to `/orders/[id]/document` (intake variant) or returns to `/orders` (manage variant).
5. From the document page the staff can: **พิมพ์เอกสาร**, **บันทึกเป็นรูปภาพ**, **ส่ง LINE OA** (when configured), **คัดลอกข้อความส่งลูกค้า**.

### 1.8 Google Sheet sync
1. `SmartOrderForm` immediately POSTs `/api/sync-order-to-sheet` with the new order id (fire-and-forget — order creation never blocks on the sheet round-trip).
2. The route requires an authenticated session (`requireRole` for any of owner / hq_admin / branch_manager / front_staff / technician), reads the order via the service-role client, and **re-verifies branch ownership** with `requireBranchAccess(order.branch_id)`. Branch-scoped roles cannot sync orders that belong to other branches.
3. The route handler calls `writeOrderRow` ([`lib/sheetWriters.ts`](../lib/sheetWriters.ts)) which routes through `insertFormattedRow` because Front_Desk has `preserveFormatting: true` in [`SHEET_CONFIGS`](../lib/sheetConfigs.ts). The exact A–O column mapping lives in [GOOGLE_SHEET_SYNC.md](./GOOGLE_SHEET_SYNC.md) — dropdowns / checkboxes / borders are preserved.
3. On success: row appended, `order_audit_log(action='sync_pushed')` written by the document page when staff hits the retry button.
4. On failure: `logSyncFailure` (`lib/syncFailures.ts`) emits a parseable `[sync-failure]` log line in the Vercel function log; the route returns 502 with the reason; the frontend remains uninterrupted.
5. The document page shows a **sync status pill** (รอซิงค์ / กำลังซิงค์ / ซิงค์แล้ว / ล้มเหลว) + retry button. The retry button re-POSTs the same route.

### 1.9 Technician flow
1. Technician opens `/orders` (sidebar shows only Dashboard + Orders for `role='technician'`).
2. Picks up an order from the list.
3. Status dropdown: `pending` → `in-progress` → `completed` → `ready-for-pickup`.
4. Every status change writes `order_audit_log(action='status_changed', before_value=old, after_value=new, changed_by=tech.uid)`.

### 1.10 Payment
1. Customer returns to pick up.
2. Document page → payment block.
3. Staff selects: ยังไม่ชำระ / มัดจำ / ชำระแล้ว.
4. `orders.payment_status` updates; `order_audit_log(action='payment_changed', …)` written.
5. Cost panel (visible only to manager+) records labor_cost + material_cost for profit reporting.

### 1.11 Archive
1. Orders with status `completed` + payment `paid` show up in `/invoices` and `/reports/revenue`.
2. No row is ever deleted. Soft archive only via status + payment combination.

---

## 2. Ezy Repair flow (shoes / bags / luggage)

> Ezy Repair is structurally similar to Care U but the job-id is auto-generated server-side and category vocabulary is different.

### 2.1 Receive order
- Same intake flow as Care U.
- Section 0 defaults to `Ezy Repair` when the current branch's brand is `ezy` (e.g. SLM).

### 2.2 Auto job ID
1. Section 5 displays a read-only preview: `SLM-YYMMDD-NNN`.
2. On submit, `lib/orderCreate.ts` calls the Postgres RPC `generate_ezy_job_id(branch_id)`.
3. The function atomically increments `job_id_sequence(branch_code, business_type, for_date)` and returns the formatted id.
4. The id is unique per branch per day per business type — see [JOB_ID_RULES.md](./JOB_ID_RULES.md).

### 2.3 Technician assignment
- Today: `orders.tech` is a free-text column (technician name / handle).
- Front-desk leaves it blank at intake; technician self-assigns when they pick up the job from the queue.
- Next phase: assignment becomes a foreign key to `profiles.id` once the staff list is populated.

### 2.4 Repair tracking
- Same status state machine as Care U: `pending → in-progress → completed → ready-for-pickup`.
- Audit log captures every status change.

### 2.5 Completion + payment + archive
- Identical to Care U §1.10 + §1.11.

---

## 3. Branch manager workflow

A `branch_manager` is responsible for one branch end-to-end.

### Daily
1. Open dashboard — sees frontdesk + production + accounting cards filtered to their branch.
2. Reviews orders in progress, urgent queue, today's revenue.
3. Approves expense entries via `/expenses` (manual entry; CSV import for bulk).
4. Reviews payment receipts and pays vendors offline.

### Weekly
1. Reviews `/reports/revenue`, `/reports/expenses`, `/reports/profit` — all branch-scoped.
2. Reviews `/reports/customers` for repeat-customer trends.
3. Adjusts staff schedules.

### Pricing
- Can view all entries on `/pricing` but only manage prices flagged for their branch (when the next-phase RLS lands). Today the UI shows the global view.

### Cannot
- Cannot see other branches' data.
- Cannot edit roles or invite new staff (HQ task).

---

## 4. HQ admin workflow

`hq_admin` is the central operations team — they manage the platform's data without owning the company financially.

### Daily
- Monitor cross-branch dashboards for anomalies (orders stuck in `pending`, sync failures, debug-sheet alerts).
- Respond to branch-manager support requests.

### Pricing (`/pricing`)
- Add / edit / disable services across the chain.
- Manage promotions (today via direct code edit in `lib/pricing.ts`; next phase: DB-backed promotions table).
- Run the **Sync to Google Sheet** button after each pricing change so finance has a CSV-friendly history.

### Staff
- `/admin/staff` (gated on `canManageStaff`) — operational staff management.
- One row per `public.profiles` user. Editable fields: role, branch_id, is_active.
- When `role='technician'` the modal also shows a technician_profiles panel (display_name, active flag, skill tags from the canonical SKILL_CATALOG, daily_wage, target_multiplier, productivity_target override). Saving upserts a `technician_profiles` row keyed by `user_id = profiles.id`.
- Quick "Active / Inactive" pill in the table column toggles `technician_profiles.active` without opening the modal — useful when a tech calls in sick.
- SQL is still the escape hatch for bulk imports or fixing a corrupt row; the UI is the day-to-day surface.

### Sheet sync hygiene
- Hit `/api/debug-sheet?dryRun=1` after any change to credentials or sheet structure.

---

## 5. Owner workflow

`owner` is the CEO. Same access as `hq_admin` plus financial decision authority.

### Daily
- Glance at consolidated dashboard.
- Look at the executive dashboard (cross-branch P&L, best/worst branch, urgent escalations).

### Weekly
- Review `/reports/branches` (best/worst branch comparison).
- Review `/reports/profit` (consolidated + per-order profit).
- Decide on branch-level investments / staffing.

### Monthly
- Approve new branch openings.
- Review accounting export from `Expense_Log` + `Front_Desk` Google Sheet tabs.
- Sign off on annual P&L.

### Authority unique to owner
- Granting `owner` to another user (today: direct SQL).
- Changing brand identity (`branches.brand`, accent colours in `lib/brandConfig.ts`).
- Closing or transferring a branch (`branches.is_active = false`).

---

## 6. Front-staff workflow

Front-staff is the highest-volume role. Optimise relentlessly.

### Per-shift checklist
1. Open `/intake` and create new orders as customers arrive.
2. Open `/orders` to update statuses and look up existing jobs.
3. Open `/customers` to add new walk-ins or correct details.
4. Print or LINE-OA-send receipts on demand.

### Cannot
- Cannot see profit / cost / revenue numbers.
- Cannot change pricing.
- Cannot switch branches.
- Cannot delete customers or orders.

### Speed targets
- New walk-in order from start to "บันทึกใบงาน" in ≤ 30 seconds on a phone.
- Pickup → "ชำระแล้ว" + "ready-for-pickup" → printed receipt in ≤ 15 seconds.

---

## 7. Technician workflow

Technicians work the production queue.

1. Open `/orders` filtered to `status in ('pending', 'in-progress')` for their branch.
2. Pick up a job — set `tech = <their name>` and move to `in-progress`.
3. Complete the physical work.
4. Set status `completed` → moves to QC.
5. (Future) QC moves to `ready-for-pickup`. Today technician sets it directly.

Technicians never see financial reports or pricing.

## 7b. Technician assignment + productivity (foundation)

> Status: **foundation only**. Data model + helper services live in code as of `20260524_technician_foundation.sql`. UI is intentionally not built yet — the next phase wires recommendations into the order document page and adds a productivity dashboard.

### 7b.1 Data model
- `public.technician_profiles` — one row per technician (`display_name`, `skill_tags text[]`, `daily_wage`, `target_multiplier` default 3, optional override `productivity_target`, `active`, `branch_id`).
- `public.orders.assigned_technician_id` (uuid → `technician_profiles`), `assigned_at`, `production_value`, `assignment_notes`.
- View `public.technician_daily_kpi` — one row per (technician, day) with assigned/completed counts and values. Branch isolation flows through `orders` RLS.

### 7b.2 Effective daily target
```
productivity_target  (when set)            → use as-is
daily_wage × target_multiplier (default 3) → fallback
neither set                                → 0 (no target tracking)
```
Example: wage 600 × multiplier 3 = **1800 THB daily target**. Anything ≥ that counts as `above_target` for the day.

### 7b.3 Production value
On orders, `production_value` defaults to NULL. The KPI view falls back to `price − material_cost` when null, so existing orders contribute to the technician's totals without a backfill. The order document page's cost panel already records `material_cost`, so the only data the system needs is `assigned_technician_id`.

### 7b.4 Assignment flow (today: programmatic only)
1. Front-desk or branch manager opens an order in `/orders/[id]/document`.
2. (Future UI) Calls `recommendTechnician({ branchId, serviceCategory, serviceCode, urgent })` from [`lib/technicianService.ts`](../lib/technicianService.ts).
3. UI shows ranked recommendations with score + reasons (skill match, today's workload).
4. Manager picks a tech → app sets `orders.assigned_technician_id`.
5. DB trigger stamps `assigned_at = now()` automatically.

Today step 2–4 happens directly through SQL or via the helper from a future component. The `orders.tech` free-text column from `20260521` stays in place as a transition fallback.

### 7b.5 KPI rollups
- `getDailyKpi(tech, date)` — one technician's day.
- `getMonthlyKpi(tech, year, month)` — full month aggregate: `totalAssigned`, `daysAboveTarget`, `daysBelowTarget`, `performanceRatio`.
- `rankTechnicians(fromDate, toDate)` — branch-scoped ranking by total assigned value.

All three live in [`lib/technicianKpi.ts`](../lib/technicianKpi.ts).

### 7b.6 Relationship to payroll
This phase ships the inputs payroll will read:
- Daily wage on each profile.
- Productivity target (computed or override).
- Daily / monthly aggregates from the view.

The payroll foundation (§9) consumes these. Nothing about a payout UI is implemented yet — wage edits stay locked to owner / hq_admin so the data shape stays correct.

## 8. Expense workflow

> Status: standardised + RLS-protected as of `20260525_payroll_foundation.sql`. UI in `/expenses` keeps the same fields the staff already use.

### 8.1 Capturing an expense
1. Branch manager (or owner / hq_admin) opens `/expenses`.
2. Fills in `expense_date`, `category` (10-value catalog in [`lib/expenses.ts`](../lib/expenses.ts)), `description`, `amount`, `payment_method`, `notes`. `branch_id` defaults to the current branch.
3. Saves. The DB trigger automatically stamps `created_by_uuid = auth.uid()` and `updated_by` / `updated_at` on subsequent edits.

### 8.2 Columns
| Column | Source | Required? |
|---|---|---|
| `branch_id` (text slug) | UI / sheet sync | yes |
| `category` | EXPENSE_CATEGORIES catalog | yes |
| `amount` | manual entry | yes |
| `expense_date` | manual entry; defaults to today | yes |
| `payment_method` | PAYMENT_METHODS catalog | optional |
| `description` / `notes` | manual entry | one of two required for audit |
| `created_by` (text) | legacy free-form attribution (sheet sync) | optional |
| `created_by_uuid` (uuid) | auto-stamped from JWT on INSERT | optional (auto) |
| `updated_at` / `updated_by` | auto-stamped on UPDATE | auto |

### 8.3 Bulk sync from Google Sheet
1. `/expenses` → "ซิงค์ Expense_Log" (owner/hq_admin only).
2. Server reads the `Expense_Log` tab via gviz CSV, dedups by content, writes new rows into `public.expenses`.
3. The trigger stamps `created_by_uuid = NULL` on these rows (sync runs as service role; the bridge JWT isn't present in that path). `created_by` text keeps the original "ผู้บันทึก" name from the sheet.

### 8.4 Branch isolation
RLS policies on `public.expenses`:
- `expenses_admin_full` — owner / hq_admin read + write any branch.
- `expenses_branch_scoped` — branch_manager read + write rows where `branch_id = current_user_branch_code()`.
- front_staff / technician have no policy → no access.

## 9b. Dashboard workflow (foundation)

> Status: **data + KPI layer refactored** as of the dashboard foundation phase. UI redesign is intentionally deferred — the existing five role-specific dashboards (FrontDesk / Production / Accounting / Manager / Executive) keep their current shape and consume the new layer.

### 9b.1 What every dashboard call goes through
1. `app/page.tsx` reads `useRole()` + `useBranch()` to determine the scope.
2. Calls `fetchDashboardSnapshot({ branchCode, allBranches })` from [`lib/dashboardData.ts`](../lib/dashboardData.ts).
3. Snapshot is passed to the role-specific component. Inside that component (or any future widget), `assembleKpis(snapshot)` from [`lib/dashboardKpi.ts`](../lib/dashboardKpi.ts) produces every operational number at once.

### 9b.2 Role-aware visibility

| Role | What the page does |
|---|---|
| owner / hq_admin | `allBranches=true` → fetches all branches; the branch tab on the right is a focus filter, not a security boundary. Dashboard tabs cycle through all five views. |
| branch_manager | `allBranches=false` → fetcher applies a client-side branch filter on top of RLS. Manager / Production / Accounting tabs visible; data scoped to own branch. |
| front_staff | Only the FrontDesk dashboard shows (single tab). Operational widgets: today's orders, pending queue, ready-for-pickup. |
| technician | Only the Production dashboard shows. Workload-focused: assigned jobs, completed today, target progress (via `getTechnicianWorkload`). |

The branch selector in the sidebar is locked for non-admin roles by the AuthContext, so even an owner switching branches doesn't change a branch-locked user's view.

### 9b.3 KPI bundle reference

`assembleKpis(snapshot)` returns:

| Field | Computed by |
|---|---|
| `salesToday` / `salesThisMonth` / `salesLastMonth` / `monthOverMonthPct` | `getSalesToday` / `getSalesThisMonth` / `getSalesLastMonth` |
| `pendingOrders` / `inProgressOrders` / `readyForPickup` | `countByStatus` |
| `completedToday` | `getCompletedToday` (array of orders) |
| `overdueJobs` / `dueSoon` | `getOverdueJobs` / `getDueSoon` (uses `orders.due_date`) |
| `topServices` (top 5) / `categoryMix` | `aggregateTopServices` / `aggregateByCategory` |
| `payments` / `profit` / `expenses` | `aggregatePayments` / `getEstimatedProfit` / `getExpenseSummary` |
| `branches` (per-branch rollup) / `customerCohort` | `aggregateByBranch` / `aggregateCustomerCohort` |
| `technicianWorkload` | `getTechnicianWorkload` — per-tech assigned/today/production |

### 9b.4 Future scaling
- Replace the direct `supabase.from('orders')` reads in `dashboardData.ts` with an RPC backed by a materialised view (`dashboard_daily_snapshot`).
- Add SWR / TanStack Query caching at the React layer for sub-second navigation.
- Add scheduled refresh of the materialised view via Supabase Cron.

The KPI layer doesn't change — it stays pure functions over the resulting arrays.

## 9. Payroll workflow (foundation)

> Status: **foundation only**. Tables + calculation helpers exist as of `20260525_payroll_foundation.sql` / [`lib/payrollService.ts`](../lib/payrollService.ts). UI lives in a future phase.

### 9.1 Data model
- `public.payroll_periods` — one row per (branch_id, year, month). Status: `open → finalized → paid` (or `cancelled`).
- `public.technician_payroll_items` — one row per technician per period. Snapshot of wage + multiplier + days_worked + production + target + bonus + deduction + final_pay.
- `public.branch_monthly_profit` (view) — revenue − material − labor − expenses per branch per month.

### 9.2 Estimating a payroll
1. Owner / hq_admin opens (future) `/admin/payroll`.
2. UI calls `calculateEstimatedPayroll(tech, year, month)` from [`lib/payrollService.ts`](../lib/payrollService.ts) for each active technician in the chosen branch.
3. Result table shows `daysWorked`, `baseWage`, `productionValue`, `targetValue`, `performanceRatio`, `aboveTarget`. Owner enters bonus / deduction; system computes `final_pay = base + bonus − deduction`.
4. "Finalize" creates a `payroll_periods` row with `status='finalized'` and one `technician_payroll_items` row per tech with the snapshot values.
5. "Mark paid" later flips `status='paid'` + stamps `paid_at` / `paid_by`.

### 9.3 Why snapshot the wage
`daily_wage_snapshot` and `target_multiplier_snapshot` on `technician_payroll_items` capture the technician's wage at finalization time. If HQ later raises the wage, last month's payroll history doesn't drift — the snapshot is immutable.

### 9.4 Branch labor cost
`calculateBranchLaborCost(branchId, fromDate, toDate)` rolls up `daily_wage × days_worked` for every technician in the branch in the window. Used by:
- The future payroll UI (preview).
- The future profit dashboard (the labor row in revenue − labor − expenses).

### 9.5 Branch profit
`fetchBranchMonthlyProfit(fromMonth, toMonth)` reads the `branch_monthly_profit` view:
```
gross_profit = revenue − material_cost − labor_cost (per-order) − operational_expenses
```
- `revenue` is sum of `orders.price` where `status='completed'`.
- `material_cost` and `labor_cost` are the per-order numbers entered by managers in the order document page's cost panel.
- `operational_expenses` is sum of `expenses.amount` for the month.

Note: per-order `labor_cost` (recorded on completion) is the "real" cost number; the payroll `final_pay` (recorded at month-end) is the "paid" number. The two converge in well-run shops but can diverge — the profit view uses the per-order value because it matches what's been incurred at the time of revenue capture.

### 9.6 Future bonus / incentive expansion
This commit ships the **inputs**. A bonus engine consumes them:
- Performance bonus = max(0, performance_ratio − 1) × base_wage × bonus_rate.
- Tenure bonus = months_employed × tenure_increment.
- Branch profit-share = branch_gross_profit × profit_share_pct.

None of those are implemented yet. The `bonus_amount` and `deduction_amount` columns on `technician_payroll_items` are owner-decided overrides; an automated engine plugs in alongside without schema changes.

---

## 9c. Operational UI principles (foundation)

> Status: **foundation only** as of 2026-05-14. The phase deliberately stops at a single new screen (`/admin/staff`) + a shared status/quick-action layer. No full redesign; existing workflows + branch isolation + RLS are unchanged.

### 9c.1 Mobile/tablet priorities
Front-desk staff use the platform on a tablet at the counter and a phone away from it. Every operational surface must:
- Render correctly at 360 px wide (test in DevTools at iPhone SE).
- Use ≥ 44 px tap targets for any primary action (`min-h-[44px]` is the project convention; see `components/QuickActionButton.tsx`).
- Prefer horizontal scrolling over wrapping when a row of tabs/filters would otherwise squash (`flex gap-2 overflow-x-auto` + `shrink-0`).
- Keep the most-used screen one tap away — the sidebar groups Operations on top of Finance and Management to enforce that.

### 9c.2 Status vocabulary
`lib/statusBadges.ts` is the **single source of truth** for every operational status pill. Every screen that renders a status shows it through `components/StatusBadge.tsx` (`OrderStatusBadge`, `PaymentStatusBadge`, `SyncStatusBadge`).

- New status code → add a row in `ORDER_STATUS_BADGES` / `PAYMENT_STATUS_BADGES` first. The rest of the app picks it up automatically.
- Never inline a per-page palette again. If a screen needs different chroma, it's a new status, not a one-off colour.

### 9c.3 Reusable quick actions
`components/QuickActionButton.tsx` is the shape for every operational quick action — print receipt, send LINE, mark ready, assign technician, resync sheet. Built-in:
- Tone palette (`primary`, `secondary`, `danger`, `neutral`) so the storefront has consistent visual hierarchy.
- 44 px minimum height + `active:scale-[0.98]` for tactile feedback on tablets.
- `loading` + `disabled` states wired in.
- `hideOnPrint` defaults to true so print receipts stay clean.

Pages adopt it incrementally — old buttons keep working until they're rewritten in a future commit.

### 9c.4 Admin centre
`/admin` is the landing page for owner / hq_admin. Today it hosts:
- `/admin/staff` — the staff management foundation (§4 Staff above).
- Pointers to `/pricing` and a stubbed "Sync recovery" card that's wired in a future phase (the underlying `lib/recoveryService.ts` exists, the UI doesn't yet).

The route is gated by the `"admin"` page key. `RouteGuard` renders the "ไม่มีสิทธิ์" panel for any role that lacks it.

### 9c.5 Operational recovery (foundation)

> Status: **foundation live** as of `20260528_recovery_foundation.sql`. The page `/admin/recovery` is the single operator surface for "the platform tried to do something and it didn't land — what now?".

#### 9c.5a Three failure surfaces today

| Surface | Source table | Writer | Reader (this phase) |
|---|---|---|---|
| Google Sheet syncs (orders, pricing, expenses, customers) | `public.sync_failures` | `lib/syncFailures.ts::logSyncFailure` (server-only) | Owner / HQ / Branch-manager (own branch) — read via supabase anon client (RLS-scoped) |
| LINE OA push attempts | `public.line_message_log` | `lib/lineDelivery.ts` orchestrator (every attempt: sent / failed / skipped) | Same role gate; RLS policies `line_message_log_admin_read` + `line_message_log_branch_read` |
| Receipt drift (cached UI vs. live DB) | none — derived on the fly | n/a | `rebuildReceiptData(orderId)` re-derives from the live order row |

#### 9c.5b Recovery actions

All actions go through `lib/recoveryService.ts` so the recovery UI doesn't learn N APIs:

| Action | Function | Server gate |
|---|---|---|
| Resync an order to Google Sheet | `resyncOrderToSheet(orderId)` → `POST /api/sync-order-to-sheet` | `requireRole(...)` + `requireBranchAccess(order.branch_id)` |
| Resend a LINE message | `resendLineMessage(orderId, kind)` → `POST /api/line/send` | `requireRole(...)` + `requireBranchAccess(order.branch_id)` |
| Mark a sync_failures row resolved | `resolveSyncFailure(failureId, note?)` → `POST /api/admin/recovery/resolve` | `requireRole(owner / hq_admin / branch_manager)` + `requireBranchAccess(row.branch_id)` |
| Rebuild a receipt | `rebuildReceiptData(orderId)` (client-side) | RLS on `orders` / `customers` |

No destructive delete actions. Every retry creates an additive log row (`line_message_log` keeps every attempt; resync writes a new sheet row only when the underlying export confirms success).

#### 9c.5c Idempotency + retry protection

1. **Resolve is idempotent.** `/api/admin/recovery/resolve` short-circuits and returns `ok: true, alreadyResolved: true` when `status='resolved'` — clicking "Mark resolved" twice does nothing harmful.
2. **In-flight set prevents double-click.** The UI tracks `retrying: Set<failureId>` and disables the row's retry button while a request is outstanding.
3. **Auto-resolve on successful retry.** After a successful resync or resend, the UI calls `resolveSyncFailure(row.id, "auto-resolved after successful retry")` so the queue drains.
4. **LINE log retries are additive.** Resending writes a new `line_message_log` row rather than mutating the failed one — the audit trail keeps every attempt.
5. **Duplicate Sheet rows are deduplicated by the writer.** `lib/sheetWriters.ts` already follows the "append-only + UI sync-status pill" contract from `8.5b`; the receiver decides idempotency at the Sheet API layer.

#### 9c.5d Failure groups (preparing for future workers)

`sync_failures.kind` is the partitioning column the future retry worker will use. After `20260528` the CHECK accepts:

| `kind` value | Source | Retry path |
|---|---|---|
| `order_to_sheet` | `/api/sync-order-to-sheet` write failure | `resyncOrderToSheet` |
| `pricing_to_sheet` | `/api/sync-pricing-to-sheet` snapshot failure | manual re-press the button (no helper yet) |
| `customer_from_sheet` | `/api/sync-customers` read failure | manual re-press |
| `expense_from_sheet` | `/api/sync-expenses` read failure | manual re-press |
| `debug_to_sheet` | `/api/debug-sheet` write failure | manual |
| `line_send` | `lib/lineDelivery.ts` push failure | `resendLineMessage` |
| `receipt_rebuild` | reserved for future cron rebuilds (no writer today) | n/a |

A cron / worker is **out of scope this phase**. The table shape and retry helpers are designed so a future worker that reads `where status='pending' order by created_at` can fire the existing helpers without any new API.

#### 9c.5e Branch isolation

- UI: `/admin/recovery` uses `RouteGuard page="recovery"`. The `"recovery"` page key is granted to owner, hq_admin, and branch_manager.
- Read: RLS on `sync_failures` has two policies — `sync_failures_admin_read` (owner / hq_admin) and `sync_failures_branch_read` (branch_manager + own branch). LINE log mirrors the same pattern.
- Write: `/api/admin/recovery/resolve` re-checks `requireBranchAccess(row.branch_id)` for branch_manager. Service-role client performs the actual UPDATE.

### 9c.5b Retry worker + bulk actions (post-2026-05-14)

> Status: **manual trigger live**. The library function `runRetryTick` is ready for a future cron schedule — wiring Supabase Cron / Vercel Cron is the only step left, and it's intentionally not done this phase.

#### 9c.5b.1 The worker tick

[`lib/retryWorker.ts::runRetryTick(opts)`](../lib/retryWorker.ts) drains up to `limit` rows from `public.sync_failures` (status in `pending` / `retrying`) ordered by `created_at`. Per row:

1. **Cooldown gate.** If `last_attempt_at` is newer than `LAST_ATTEMPT_BACKOFF_SECONDS` (60s), skip — protects LINE customers from being spammed by an over-eager worker.
2. **Flag retrying.** UPDATE attempts++, last_attempt_at=now, status='retrying'.
3. **Dispatch via `retryFailureItem`.** Routes by `kind`:
   - `order_to_sheet` → `syncOrderToSheetCore(targetId)` (server-side, RLS-bypassing admin client).
   - `line_send` → `dispatchLineKind` resolves the `messageKind` from `payload.messageKind` and calls the matching orchestrator (`sendOrderCreatedMessage` / …). A LINE "skipped" outcome (no LINE link, customer unsubscribed) is treated as success so the worker stops retrying it.
   - `receipt_rebuild` → no-op success; rebuild is a pure read and only meaningful in the admin UI.
   - Other kinds → returns `manual retry only — kind "X" has no auto-retry path`. Worker leaves the row at status=pending without bumping toward dead.
4. **Mark resolved or pending.** On success → status='resolved', resolved_at=now, payload merged with `autoResolvedBy` + `autoResolvedAt` + `lastRetryDetails`. On failure → if `attempts >= MAX_ATTEMPTS` (5) → status='dead'; otherwise → status='pending' with `payload.lastRetryReason`.

The function never throws. Every per-row exception lands as `{ ok: false, reason }` in the returned `RetryTickResult.items`.

#### 9c.5b.2 Manual trigger

`POST /api/admin/recovery/run-worker` (owner / hq_admin / branch_manager). For `branch_manager`, the body's `branchCode` is ignored — the route forces it to `profile.branchCode`. Owner / HQ may pass `branchCode: null` to drain across every branch.

The admin UI's "Run worker (25)" button surfaces a confirmation modal, then shows a per-row summary card (`WorkerSummary` component) with counts of succeeded / pending / dead / skipped plus collapsible per-row details.

#### 9c.5b.3 Future cron entry point

A cron job that POSTs to `/api/admin/recovery/run-worker` (or calls `runRetryTick({ actorId: 'cron' })` directly server-side) drains the queue without operator presence. The library is ready; cron config is the missing piece. Cron schedulers must respect the per-row cooldown — the worker rejects double-attempts inside 60s on their own, so a 60s cron tick is the lower bound.

#### 9c.5b.4 Bulk resolve

`POST /api/admin/recovery/bulk-resolve` accepts up to 100 `failureIds` and stamps each with a shared `bulkActionId` in `payload.jsonb`. Per-row branch isolation: a `branch_manager` who submits a foreign-branch id gets per-row 403 (`ไม่มีสิทธิ์เข้าถึงสาขาของรายการนี้`); the rest of the list still processes. Already-resolved rows short-circuit as `alreadyResolved: true`.

#### 9c.5b.5 Safety contract recap

| Concern | Mitigation |
|---|---|
| LINE spam on a flaky channel | 60s per-row cooldown + MAX_ATTEMPTS=5 + LINE "skipped" treated as success |
| Sheet duplicate rows | Column-B Job ID dedup in `writeOrderRow` (see GOOGLE_SHEET_SYNC.md §8b) |
| Worker timeout | Hard-capped `limit` at 50 per tick |
| Stuck "retrying" rows | Cooldown gate re-evaluates on next tick; UI shows `attempts` so admins can resolve manually |
| Unknown kind | Dispatcher returns `unknown kind "..."` — never crashes the loop |
| Service-role unset | Worker returns a skipped-only result with a clear reason |
| Cross-branch retry | Branch manager's `branchCode` is forced server-side; per-row check in bulk-resolve |

### 9c.6 What this phase does NOT do
Deliberate non-goals to keep the foundation focused:
- No CRM automation, no advanced BI, no franchise automation.
- No full UI redesign — the storefront keeps its current shape.
- No customer-facing website / portal.
- No new tables or migrations (`profiles` + `technician_profiles` are already in place).

---

## 8. Cross-cutting workflows

### 8.1 Customer sync from sheet
1. `/customers` → "ซิงค์จาก Google Sheet".
2. Server reads `Data_Center` tab via gviz CSV, matches columns name + phone, upserts into `customers` keyed by `normalized_phone`.
3. Returns `{ inserted, matchedExisting, skipped, totalRows }`. UI shows a Thai summary.

### 8.2 Expense sync from sheet
1. `/expenses` → "ซิงค์จาก Google Sheet".
2. Server reads `Expense_Log` tab, parses by header row, upserts into `expense_log`.

### 8.3 Order document export
1. From `/orders/[id]/document`:
   - **PrintModeSelector** → switch between A4 / Thermal (80mm) / Mobile templates. Receipt re-renders instantly.
   - **Print** → `printReceipt({ mode })` in [`lib/printService.ts`](../lib/printService.ts) sets the body class, calls `window.print()`, then cleans up. Page-size swap happens via `body.printing-thermal @page { size: 80mm auto; }` in [`app/globals.css`](../app/globals.css).
   - **Save as image** → `saveReceiptAsImage({ receipt })` renders the visible receipt template via `html-to-image::toJpeg` at 2× pixel ratio. Filename = `careu-{refId}.jpg`.
   - **LINE OA send (text)** → `sendToLineOA` with `buildCustomerMessage(order, branch)`. Image push stub: `sendReceiptViaLine(receipt)` in [`lib/printService.ts`](../lib/printService.ts).
   - **Copy message** → plain-text snippet via `buildCustomerMessage`.
   - **Sync to Sheet** → `POST /api/sync-order-to-sheet`; sync-status pill in the action bar tracks idle / syncing / success / failed.

### 8.4 Audit log
Every business-meaningful state change writes one row to one of three audit tables. All three are append-only + RLS-restricted to owner / hq_admin reads.

| Audit table | Domain | Writer | Actions |
|---|---|---|---|
| `public.order_audit_log` | orders | app via [`lib/auditService.ts`](../lib/auditService.ts) or direct insert | `created`, `status_changed`, `payment_changed`, `cost_updated`, `cancelled`, `sync_pushed`, `assigned`, `receipt_regenerated`, `sync_failed` |
| `public.pricing_audit_logs` | service_prices | DB trigger (SECURITY DEFINER) | `create`, `update`, `disable`, `activate`, `delete` |
| `public.expense_audit_log` | expenses | DB trigger (SECURITY DEFINER) | `create`, `update`, `delete` |

The trigger-driven tables (pricing / expense) are impossible to forget — every row change is logged. The app-driven table (orders) is the canonical path for events with meaningful before/after metadata that's not a simple row diff (e.g. "sync_pushed" carries the target Sheet tab, not a column delta).

### 8.5 Failure handling philosophy
1. **Order create succeeds before secondary effects.** The `/intake` form persists to `public.orders` then fire-and-forgets the Google Sheet sync. A sync outage never blocks the staff workflow.
2. **Failures land in two places.** [`lib/syncFailures.ts::logSyncFailure`](../lib/syncFailures.ts) emits a parseable `[sync-failure]` log line AND inserts a row into `public.sync_failures` (when `SUPABASE_SERVICE_ROLE_KEY` is set). The DB queue is owner / hq_admin readable + the basis for a future cron retry.
3. **Recovery is one module.** [`lib/recoveryService.ts`](../lib/recoveryService.ts) — `listFailedSyncs`, `markSyncResolved`, `resyncOrderToSheet`, `rebuildReceiptData`. A future `/admin/recovery` page imports all four.

### 8.5b LINE OA messaging (MVP)

Four customer-facing message kinds, all triggered manually from the staff UI in the MVP:

| Kind | When | Trigger today |
|---|---|---|
| `order_received` | Right after `/intake` create | Manual button (future: auto via `branch_line_configs.auto_send_order_received`) |
| `order_ready` | Status flips to `completed` / `ready-for-pickup` | Manual button on `/orders/[id]/document` |
| `pickup_reminder` | Ready job hasn't been picked up | Manual button (future: cron) |
| `receipt` | Customer asks for receipt link | "Send LINE OA" button → falls through `buildCustomerMessage` |

Flow:
1. Browser calls `sendLineMessage(kind, orderId)` from [`lib/lineOA.ts`](../lib/lineOA.ts).
2. `POST /api/line/send` re-checks role (owner / hq_admin / branch_manager / front_staff) **AND** re-checks branch ownership: it loads `orders.branch_id` via the service-role client and calls `requireBranchAccess(branch)` before invoking the orchestrator. Branch-scoped roles cannot trigger LINE sends for foreign-branch orders.
3. Orchestrator in [`lib/lineDelivery.ts`](../lib/lineDelivery.ts):
   - Loads order + customer + branch via service role.
   - Looks up `customer_line_links` for the customer. **No link → skip** (logged).
   - Reads notification prefs + unsubscribed status. **Pref off / unsubscribed → skip**.
   - Resolves channel config via [`lib/lineConfig.ts`](../lib/lineConfig.ts) (per-branch row → env fallback).
   - Builds message text via [`lib/lineMessageBuilders.ts`](../lib/lineMessageBuilders.ts).
   - Pushes via [`lib/lineMessaging.ts`](../lib/lineMessaging.ts).
   - Writes one row to `public.line_message_log` regardless of outcome.

Failures never block the order workflow — the route returns 200 with `ok: false` and the UI shows a toast.

### 8.5c LINE customer linkage

`public.customer_line_links` maps `customer_id ↔ line_user_id`. Populated three ways:

| Method | Status |
|---|---|
| LINE follow webhook | **Next phase** (customer scans OA QR → server captures userId → upsert link with `consented_at`) |
| Admin SQL | Works today (`INSERT INTO public.customer_line_links …`) |
| `/admin/customer-line` UI | Future — same admin flow as the planned `/admin/staff` page |

Per-kind notification prefs are on the link row (`notify_order_received`, `notify_order_ready`, etc.). Unsubscribe sets `unsubscribed_at` and overrides every per-kind flag.

### 8.6 Validation rules
Three layers:

| Layer | Where | What it catches |
|---|---|---|
| UI | [`lib/validation.ts`](../lib/validation.ts) called from forms | Friendly Thai errors before submit (empty fields, malformed Job ID, negative amounts, past due-date) |
| App | Service helpers / route handlers | Re-validation so the API never trusts the UI alone |
| DB | CHECK constraints + triggers from `20260526` | Last line of defence — rejects bad writes regardless of how they arrived. `validate_order_assignment` trigger rejects inactive-tech + cross-branch assignment |

Canonical status values are enforced by DB CHECKs:
- `orders.status` ∈ `pending | in-progress | completed | ready-for-pickup | cancelled`
- `orders.payment_status` ∈ `unpaid | deposit | paid`
- `orders.quantity` ≥ 1, `price` / `urgent_fee` / `discount` ≥ 0

Older rows that pre-date a constraint are exempt (constraints are `NOT VALID`); staff fix them via the normal UI when they next touch the row.

---

**Last updated:** 2026-05-13 (sheet preservation refactor)
