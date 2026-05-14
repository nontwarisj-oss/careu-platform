# CareU OPS Platform — Franchise / Branch Onboarding

> **Status:** permanent reference. The onboarding wizard at `/admin/onboarding` is the canonical path to bring a new branch online without touching SQL. Owner / hq_admin only.

---

## 1. Why a wizard

Onboarding a franchise touches several tables and a few external configurations:

| Surface | Action |
|---|---|
| `public.branches` | Insert a new row (text slug `code`, short_code for Job IDs, brand, type). |
| `lib/brandConfig.ts` | Add a UI mirror entry so labels render correctly. |
| `public.branch_line_configs` | Optional — placeholder row so per-branch LINE OA tokens can be filled later. |
| `public.profiles` | Pin staff to the new branch (handled in `/admin/staff`). |
| `public.service_prices` | Optional — branch-specific price overrides (`branch_id IS NOT NULL`). |
| Google Sheet | The shared Sheet doesn't need per-branch setup; orders for any branch land on the `Front_Desk` tab. |

The wizard handles the DB-side work; the rest stays in operator hands (with a checklist surfaced in the UI).

---

## 2. Safety defaults

The platform errs on the side of "create now, activate later":

- **`is_active = false`** on every new branch. The branch doesn't appear in selectors until activation, so a half-configured branch can't accidentally receive orders.
- **Duplicate `code` rejected with HTTP 409.** Validation runs server-side before the insert so the operator sees a friendly Thai error rather than a raw constraint violation.
- **Activation is a separate request.** `/api/admin/onboarding/activate-branch` flips `is_active`; the operator must explicitly confirm.
- **No destructive delete.** The wizard never deletes a branch. Closing a branch deactivates it; existing orders + customers stay in their original branch_id.

---

## 3. The wizard

Three sections on one page (`app/admin/onboarding/page.tsx`):

### 3.1 Step 1 — Branch basics

| Field | Validation |
|---|---|
| `code` (slug) | `/^[a-z0-9][a-z0-9-]{1,63}$/` — lowercase, digits, dashes. Becomes `branches.code` and joins against `orders.branch_id` / `customers.branch_id`. |
| `short_code` | `/^[A-Z0-9]{2,8}$/` — uppercase prefix used in Ezy Job IDs (e.g. `SLM`, `C24`). |
| `name` | Free text — full shop name. |
| `type` | `mixed` (default), `care_u`, or `ezy_repair`. Drives which intake flow is offered. |
| `brand` | Optional — `careu`, `ezy`, or blank. Drives accent colour + receipt logo via `brandConfig`. |

A live "code available" indicator runs as the operator types — checked client-side against the loaded branches list. Server-side re-checks at submit.

### 3.2 Step 2 — Reserve config slots

Single toggle:

- **Create empty `branch_line_configs` row** (default on). Reserves the row so a future LINE token update is a plain `UPDATE` rather than an `INSERT` + RLS check.

### 3.3 Step 3 — UI metadata (optional, post-`20260533`)

Migration `20260533` mirrors the lib/brandConfig.ts shape into `public.branches`. The wizard now accepts the UI fields directly so no code edit is needed:

| Field | DB column | Default when blank |
|---|---|---|
| Short label | `short_label` | `"<short_code> • <name>"` |
| Receipt name | `receipt_name` | `name` |
| Tagline | `tagline` | NULL |
| Address | `address` | NULL |
| Phone | `phone` | `"N/A"` |
| Logo path | `logo_path` | brand-derived (`/logos/c24-careu.svg` or `/logos/ezy-repair.svg`) |
| Accent class | `accent_class` | brand-derived (Tailwind gradient) |

`lib/branchContext.tsx` reads these columns at session start; missing fields fall back to the matching seed entry in `lib/brandConfig.ts`. The hardcoded list stays as a safe fallback when the DB read fails or the migration hasn't run yet.

### 3.4 Step 4 — Manual checklist (post-2026-05-14)

The brandConfig.ts mirror step is **gone** — the wizard handles it. Remaining manual steps:

1. Add staff via `/admin/staff` and pin them to the new branch.
2. If using per-branch LINE OA: `UPDATE branch_line_configs SET channel_access_token = '...' WHERE branch_id = '...'`.
3. Review `service_prices` — if global pricing covers it, no action.
4. Return to `/admin/onboarding` and **Activate** the branch.

---

## 4. API surface

### 4.1 `POST /api/admin/onboarding/create-branch`

Body:

```ts
{
  code: string;            // required, slug regex
  short_code: string;      // required, 2-8 upper
  name: string;            // required
  type?: "care_u" | "ezy_repair" | "mixed";  // default "mixed"
  brand?: "careu" | "ezy" | null;
  createLineConfig?: boolean;
}
```

Returns:

```ts
{
  ok: true,
  branch: { id, code, short_code, name, type, brand, is_active: false, created_at },
  createdBy: <profile.id>,
  nextSteps: string[]  // checklist for the operator
}
```

Failure modes:

| Status | Reason |
|---|---|
| 400 | Validation failure — missing or malformed field. |
| 409 | `code` already exists. Response includes `existingBranchId`. |
| 403 | Caller is not owner / hq_admin. |
| 500 | DB error. |
| 503 | `SUPABASE_SERVICE_ROLE_KEY` not configured. |

### 4.2 `POST /api/admin/onboarding/activate-branch`

Body: `{ branchId, isActive }`. Flips `branches.is_active`. Idempotent on no-op.

Used for both initial activation AND later deactivation (close a franchise without deleting). No destructive delete is exposed.

---

## 5. Permission matrix

| Action | Role |
|---|---|
| Open `/admin/onboarding` | owner / hq_admin (admin page key) |
| Create branch | owner / hq_admin |
| Activate / deactivate branch | owner / hq_admin |
| View branch list on the page | owner / hq_admin (read filtered by RLS on `branches` — admin sees all) |
| branch_manager / front_staff / technician | denied at RouteGuard |

---

## 6. Multi-brand support

The wizard treats brand as informational metadata. The platform already supports two brands (`careu`, `ezy`) end-to-end via `lib/brandConfig.ts`. To add a third brand:

1. Add a constant to `BRAND_KEYS` (or accept any string — today the column is `text` with no CHECK).
2. Add the brand's UI metadata to `brandConfig` (logo, accent class, receipt name).
3. Create the new branch via the wizard with `brand: 'newbrand'`.
4. Update the intake form's brand-routing logic if the new brand has a different intake flow (today the form switches between Care U and Ezy Repair based on the branch's `brand`).

---

## 7. What this phase does NOT do

By design — these belong to future phases:

| Step | Why |
|---|---|
| ~~Auto-mirror to `lib/brandConfig.ts`~~ | ✅ Done via `20260533` — UI fields live in `public.branches` columns; branchContext reads from DB with the hardcoded list as a fallback. |
| Bulk import branches from CSV | Foundation only — most chains add branches one at a time. |
| Per-branch LINE channel registration UI | Reserved row exists; the token UPDATE is admin SQL today. |
| Per-branch Google Sheet tab | The platform uses one global Sheet today. Per-branch tabs are a scaling decision, not an onboarding decision. |
| Franchise contract / billing | Out of scope. The platform is operations, not commerce. |

---

**Last updated:** 2026-05-14 (brandConfig DB mirror — wizard now collects every UI field; lib/brandConfig.ts stays as fallback only)
