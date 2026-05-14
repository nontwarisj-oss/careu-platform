# CareU OPS Platform — Role × Permission Matrix

> **Status:** permanent reference. UI guards in [`lib/permissions.ts`](../lib/permissions.ts) and DB policies in [RLS_POLICY.md](./RLS_POLICY.md) must match this matrix.

---

## 1. Roles

The 5 canonical roles (codes in [`lib/roles.ts`](../lib/roles.ts)):

| Code | Label (TH) | Label (EN) | Who |
|---|---|---|---|
| `owner` | เจ้าของกิจการ | Owner | Company CEO / shop owner |
| `hq_admin` | แอดมินสำนักงานใหญ่ | HQ admin | Central ops / pricing manager |
| `branch_manager` | ผู้จัดการสาขา | Branch manager | Branch owner / shop supervisor |
| `front_staff` | พนักงานหน้าร้าน | Front staff | Cashier / receptionist |
| `technician` | ช่างซ่อม | Technician | Repair / alteration craftsperson |

Legacy codes (`CEO`, `AREA_MANAGER`, `FRONT_DESK`, …) auto-map via `normalizeRole`.

---

## 2. Master matrix

Legend: ✅ = full access · 👁 = read only · 🏢 = own branch only · ❌ = no access · ⚠ = restricted (see note)

| Capability | owner | hq_admin | branch_manager | front_staff | technician |
|---|---|---|---|---|---|
| **Dashboard — Executive** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Dashboard — Manager** | ✅ | ✅ | ✅ (own branch) | ❌ | ❌ |
| **Dashboard — Accounting** | ✅ | ✅ | ✅ (own branch) | ❌ | ❌ |
| **Dashboard — Front Desk** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Dashboard — Production** | ✅ | ✅ | ✅ | ❌ | ✅ |
| **/intake** (create new order) | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ❌ |
| **/orders** (list) | ✅ all | ✅ all | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 |
| **/orders status change** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 |
| **/orders/[id]/document — view** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 |
| **/orders/[id]/document — payment change** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ❌ |
| **/orders/[id]/document — cost panel** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/customers** (list + edit) | ✅ all | ✅ all | ✅ 🏢 | ✅ 🏢 | 👁 🏢 |
| **/customers — import CSV** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **/customers — sync from sheet** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **/customers — view history** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | 👁 🏢 |
| **/invoices** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/expenses — view** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/expenses — add** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/expenses — sync from sheet** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **/reports/revenue** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/reports/profit** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/reports/branches (cross-branch)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **/reports/customers** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/reports/expenses** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/pricing — view** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **/pricing — edit prices** | ✅ | ✅ | ⚠ own branch overrides | ❌ | ❌ |
| **/pricing — disable / enable** | ✅ | ✅ | ⚠ own branch overrides | ❌ | ❌ |
| **/pricing — sync to sheet** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Branch selector (top bar)** | ✅ all branches | ✅ all branches | 🏢 locked | 🏢 locked | 🏢 locked |
| **Order form — choose another branch** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Order form — business type override** | ✅ | ✅ | ✅ | ✅ | n/a |
| **Audit log (`order_audit_log`)** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **Manage staff (promote / demote / disable)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`/admin` centre + `/admin/staff` UI** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`/admin/recovery` UI (sync_failures + LINE log + receipt rebuild)** | ✅ all branches | ✅ all branches | ✅ 🏢 own branch | ❌ | ❌ |
| **Retry sync / resend LINE** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **Mark sync_failures resolved** | ✅ | ✅ | ✅ 🏢 (own branch only — gated via `/api/admin/recovery/resolve`) | ❌ | ❌ |
| **Bulk resolve via `/api/admin/recovery/bulk-resolve`** | ✅ all | ✅ all | ✅ 🏢 (per-row branch check) | ❌ | ❌ |
| **Run retry worker via `/api/admin/recovery/run-worker`** | ✅ any/all branches | ✅ any/all branches | ✅ 🏢 (branchCode forced to own) | ❌ | ❌ |
| **Cron retry tick via `/api/cron/retry-worker`** | ⚠ machine-only (Bearer CRON_SECRET) — no role gate; not callable from the UI | same | same | same | same |
| **LINE follow webhook `/api/line/webhook`** | ⚠ machine-only (LINE platform; verified by HMAC over LINE_CHANNEL_SECRET) | same | same | same | same |
| **`worker_runs` read** | ✅ all branches | ✅ all branches | ❌ (admin-only RLS policy) | ❌ | ❌ |
| **`line_follow_events` read** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Manage branches (create / disable)** | ✅ | ⚠ propose only | ❌ | ❌ | ❌ |
| **technician_profiles — view list** | ✅ all | ✅ all | ✅ 🏢 | ✅ 🏢 (for assignment) | ✅ 🏢 (own row) |
| **technician_profiles — create / edit wage / target** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **technician_profiles — toggle active** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Order assignment (`orders.assigned_technician_id`)** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 (self-assign) |
| **Productivity KPI view** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ✅ own row only |
| **`/expenses` view + add** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ❌ |
| **`/expenses` sync from sheet** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **payroll_periods — view** | ✅ all | ✅ all | 👁 🏢 (read only) | ❌ | ❌ |
| **payroll_periods — create / finalize / pay** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **technician_payroll_items — view** | ✅ all | ✅ all | 👁 🏢 (own branch only via period join) | ❌ | ❌ |
| **technician_payroll_items — edit (bonus / deduction)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **branch_monthly_profit view** | ✅ all branches | ✅ all branches | 👁 🏢 (own branch only) | ❌ | ❌ |
| **calculateBranchLaborCost** | ✅ | ✅ | ✅ 🏢 (own branch only) | ❌ | ❌ |
| **Dashboard — fetch snapshot (`fetchDashboardSnapshot`)** | ✅ all branches | ✅ all branches | ✅ 🏢 (own branch via RLS + client filter) | ✅ 🏢 (front-desk tab only) | ✅ 🏢 (production tab only) |
| **Dashboard — KPI bundle (`assembleKpis`)** | ✅ full bundle | ✅ full bundle | ✅ scoped bundle | ✅ operational subset (no financials) | ✅ workload-only subset |
| **Receipt view (`/orders/[id]/document`)** | ✅ all | ✅ all | ✅ 🏢 (RLS) | ✅ 🏢 (RLS) | ✅ 🏢 (RLS, view-only) |
| **Receipt print (A4 / thermal / mobile)** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 |
| **Save receipt as image** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 |
| **Receipt — internal cost panel (labor/material)** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **Receipt — payment status edit** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ❌ |
| **Receipt — sync to Google Sheet** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 (on own orders) |
| **LINE OA — trigger send** | ✅ all kinds | ✅ all kinds | ✅ 🏢 all kinds | ✅ 🏢 all kinds | ❌ |
| **`customer_line_links` — view** | ✅ all | ✅ all | ✅ 🏢 (via customer.branch_id) | ✅ 🏢 | ❌ |
| **`customer_line_links` — create / unsubscribe** | ✅ | ✅ | ❌ (PDPA — admin-controlled) | ❌ | ❌ |
| **`line_message_log` — read** | ✅ all branches | ✅ all branches | 👁 🏢 (own branch) | ❌ | ❌ |
| **`branch_line_configs` — view / rotate tokens** | ✅ (via service role) | ✅ (via service role) | ❌ | ❌ | ❌ |

---

## 3. Capability helpers (`lib/permissions.ts`)

The matrix above is encoded as pure functions:

| Helper | Returns true for |
|---|---|
| `canViewAllBranches(role)` | `owner`, `hq_admin` |
| `canViewReports(role)` | `owner`, `hq_admin`, `branch_manager` |
| `canCreateOrder(role)` | `owner`, `hq_admin`, `branch_manager`, `front_staff` |
| `canManagePricing(role)` | `owner`, `hq_admin` |
| `canManageStaff(role)` | `owner`, `hq_admin` |
| `canSeeFinancials(role)` | `owner`, `hq_admin`, `branch_manager` |
| `canChooseAnotherBranch(role)` | `owner`, `hq_admin` |
| `canEditOrderCosts(role)` | `owner`, `hq_admin`, `branch_manager` |
| `canChangeJobStatus(role)` | everyone except an unknown role |

**Rule:** UI surfaces consult these helpers. The matrix in this doc is the spec; the helpers are the implementation. PRs change them together.

---

## 4. Branch-scope semantics

A row in `orders` / `customers` is owned by exactly one branch (`branch_id text` matching `branches.code`).

| Role | What "own branch only" means |
|---|---|
| `owner`, `hq_admin` | Their session has no branch filter. They see every branch in every table. |
| `branch_manager`, `front_staff`, `technician` | `profiles.branch_id` resolved to `branches.code` is the only branch they can read/write. Branch selector in sidebar is locked. |

Cross-branch reads attempted by a branch-locked role are denied at three layers:
1. The branch selector is disabled, so they cannot navigate to another branch's filter.
2. The route handlers (server-side) read `branch_id` from the session, not the request body.
3. RLS policies (next-phase) on `orders` / `customers` filter by `current_user_branch_code()`.

---

## 5. Sidebar navigation visibility

The sidebar reads `role.pages` and shows only items the role can access. Items are grouped operationally so the screens used most often (intake, orders, customers) sit at the top of each role's nav. Today's per-role nav set:

| Role | Operations | Finance | Management |
|---|---|---|---|
| `owner` | Dashboard, Walk-in intake, Orders, Customers | Invoices, Expenses, Reports | Pricing, **Admin centre**, **Recovery** |
| `hq_admin` | Dashboard, Walk-in intake, Orders, Customers | Invoices, Expenses, Reports | Pricing, **Admin centre**, **Recovery** |
| `branch_manager` | Dashboard, Walk-in intake, Orders, Customers | Invoices, Expenses, Reports | Pricing, **Recovery** (own branch) |
| `front_staff` | Dashboard, Walk-in intake, Orders, Customers | — | — |
| `technician` | Dashboard, Orders | — | — |

`canAccessPage(role, page)` is the single source of truth — see [`lib/roles.ts`](../lib/roles.ts). Two management-tier page keys today:
- `"admin"` gates `/admin` and `/admin/staff`. Only `owner` and `hq_admin` have it (via their `["*"]` set).
- `"recovery"` gates `/admin/recovery`. Granted to `owner`, `hq_admin`, and `branch_manager`. The branch_manager view is scoped to their branch by RLS (`sync_failures_branch_read`) + `requireBranchAccess` in `/api/admin/recovery/resolve`.

---

## 6. Google Sheet access

The `SUPABASE_SERVICE_ROLE_KEY` and the `GOOGLE_*` keys are NOT scoped per role — they are deployment-wide. The route handlers themselves are the role check.

| Sync route | Roles allowed to trigger |
|---|---|
| `POST /api/sync-order-to-sheet` | Any role with `canCreateOrder` (front_staff and above) — the route is called automatically after order create + manually from the document page. |
| `POST /api/sync-pricing-to-sheet` | `canManagePricing` (`owner`, `hq_admin`) — surfaced from `/pricing` only. |
| `POST /api/sync-customers` | `canManagePricing` today (called from `/customers` "ซิงค์จาก Google Sheet"). Next phase: gate by `canManageStaff`. |
| `POST /api/sync-expenses` | `canSeeFinancials` (`owner`, `hq_admin`, `branch_manager`). |
| `GET /api/debug-sheet[?dryRun=1]` | `owner` / `hq_admin` only — diagnostic. Today no route-level enforcement; add `canManageStaff` check in next phase. |

---

## 7. LINE OA send

Today: stubbed. Once `LINE_CHANNEL_ACCESS_TOKEN` is configured, sending a customer message from `/orders/[id]/document` requires:

| Action | Roles |
|---|---|
| Send Line OA from receipt page | `owner`, `hq_admin`, `branch_manager`, `front_staff` |
| Configure LINE channel (env vars) | Deploy admin (out of band) |
| Customise message template | `owner`, `hq_admin` (next phase: `/admin/templates`) |

---

## 8. Cross-cutting financial visibility rule

If a screen contains profit / margin / cost / labor / material values, it must be wrapped in `if (canSeeFinancials(role))`. This is the easiest gate to forget. Use the helper, never inline the role list.

```tsx
import { canSeeFinancials } from "@/lib/permissions";
import { useRole } from "@/lib/roleContext";

const { role } = useRole();
if (!canSeeFinancials(role)) return null;
// ... profit numbers below ...
```

---

## 9. First-user bootstrap

The very first LINE login on a fresh database is bootstrapped as `role='owner'` in [`app/api/auth/line/callback/route.ts`](../app/api/auth/line/callback/route.ts).

After that, every new user defaults to `role='front_staff'`. Promotion to `branch_manager`, `hq_admin`, etc. is done by an existing `owner`/`hq_admin` via SQL today; next phase adds an `/admin/staff` UI.

---

## 10. Audit visibility

The audit log (`public.order_audit_log`) is read-only and visible to **owner** / **hq_admin** / **branch_manager** (filtered to own branch via a join on `orders`). The UI to surface it lives in the next phase; for now, queries hit the table directly.

---

## 11. Editing this matrix

This document defines the contract. Whenever a permission changes:

1. Update the row in this matrix.
2. Update the matching helper in `lib/permissions.ts`.
3. Update the policy in `RLS_POLICY.md` (and the next-phase SQL in the migration).
4. Add a row to the changelog at the bottom of this file.

---

## 12. Changelog

| Date | Change | Commit |
|---|---|---|
| 2026-05-13 | Initial 5-role matrix established. | 4805d3b |
| 2026-05-14 | Added `admin` page key. `/admin` + `/admin/staff` UI surfaces owner / hq_admin staff management (role, branch, active, wage, skills). Sidebar grouped Operations / Finance / Management. | — |
| 2026-05-14 | Added `recovery` page key. `/admin/recovery` UI gives owner / hq_admin (all branches) + branch_manager (own branch) sync_failures + LINE log visibility, with retry / resend / resolve / receipt-rebuild actions. Migration `20260528` adds branch-scoped read on `sync_failures` and extends `kind` CHECK with `'line_send'` + `'receipt_rebuild'`. | — |

---

**Last updated:** 2026-05-14 (cron + per-kind retry policy + LINE follow webhook phase)
