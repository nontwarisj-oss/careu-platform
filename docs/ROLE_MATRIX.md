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
| **Manage branches (create / disable)** | ✅ | ⚠ propose only | ❌ | ❌ | ❌ |

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

The sidebar reads `role.pages` and shows only items the role can access. Today's per-role nav set:

| Role | Visible nav items |
|---|---|
| `owner` | Dashboard, Walk-in intake, Customers, Orders, Invoices, Expenses, Reports, Pricing |
| `hq_admin` | Dashboard, Walk-in intake, Customers, Orders, Invoices, Expenses, Reports, Pricing |
| `branch_manager` | Dashboard, Walk-in intake, Customers, Orders, Invoices, Expenses, Reports, Pricing |
| `front_staff` | Dashboard, Walk-in intake, Customers, Orders |
| `technician` | Dashboard, Orders |

`canAccessPage(role, page)` is the single source of truth — see [`lib/roles.ts`](../lib/roles.ts).

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

---

**Last updated:** 2026-05-13 (commit 4805d3b)
