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
2. The route handler calls `writeOrderRow` ([`lib/sheetWriters.ts`](../lib/sheetWriters.ts)) which routes through `insertFormattedRow` because Front_Desk has `preserveFormatting: true` in [`SHEET_CONFIGS`](../lib/sheetConfigs.ts). The exact A–O column mapping lives in [GOOGLE_SHEET_SYNC.md](./GOOGLE_SHEET_SYNC.md) — dropdowns / checkboxes / borders are preserved.
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
- Today: SQL-only (`UPDATE public.profiles SET role='branch_manager' WHERE …`).
- Next phase: `/admin/staff` UI gated on `canManageStaff`.

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
   - **Print** → browser native print, A4 portrait, payment block hidden when status=paid.
   - **Save as image** → `html-to-image::toJpeg` at 2× pixel ratio.
   - **LINE OA send** → server-side push (stubbed; awaits `LINE_CHANNEL_ACCESS_TOKEN`).
   - **Copy message** → uses `buildCustomerMessage` to produce a chat-friendly Thai text snippet.

### 8.4 Audit log
Every business-meaningful state change writes one row to `public.order_audit_log`:
- `created` (from `createSmartOrder`)
- `status_changed` (from `/orders` list and document page)
- `payment_changed` (from document page)
- `cost_updated` (from document page cost panel)
- `sync_pushed` (from `/api/sync-order-to-sheet` success)

Audit log is append-only and visible to `owner` / `hq_admin` only.

---

**Last updated:** 2026-05-13 (sheet preservation refactor)
