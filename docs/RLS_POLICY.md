# CareU OPS Platform — RLS Policy

> **Status:** permanent reference. The database is the real enforcement layer; UI guards are convenience only.

---

## 1. Current state (as of commit 4805d3b)

| Table | RLS | Effective enforcement |
|---|---|---|
| `branches` | **ON** | Read-only for everyone; writes require service role. |
| `profiles` | **ON** | Authenticated user can read their own row only; service role writes. |
| `job_id_sequence` | **ON** | Service role only (no policies). |
| `roles` | OFF | Reference data, no sensitive content. |
| `orders` | **OFF (transitional)** | Strict policies in [§6](#6-next-phase-strict-policies-for-orders--customers) ship commented-out. |
| `customers` | **OFF (transitional)** | Same. |
| `expense_log` | OFF | Same. |
| `service_prices` | OFF | Same. |
| `order_audit_log` | OFF | Same. |
| `users` (legacy) | OFF | Being phased out in favour of `profiles`. |

**Why orders / customers are still RLS-off:** today's session layer is the LINE-cookie HMAC, not Supabase Auth, so `auth.uid()` is NULL inside Postgres and any policy that references it would deny every read. The strict policy SQL is staged in the migration. Once the LINE → Supabase Auth bridge ships, flip them in a one-line migration.

**This is the only sanctioned exception** to the "RLS always on" rule. It exists for one upgrade window and ends with the next auth migration.

---

## 2. Roles

The 5 canonical roles from [`lib/roles.ts`](../lib/roles.ts):

| Code | Branch scope | Sees financials | Typical user |
|---|---|---|---|
| `owner` | all | yes | Company CEO |
| `hq_admin` | all | yes | Central ops / pricing manager |
| `branch_manager` | own branch | yes | Branch owner / supervisor |
| `front_staff` | own branch | **no** | Cashier / receptionist |
| `technician` | own branch | **no** | Repair/alteration craftsperson |

Legacy codes (`CEO`, `AREA_MANAGER`, `BRANCH_MANAGER`, `FRONT_DESK`, `TECHNICIAN`, `ACCOUNTANT`, `FRANCHISE_OWNER`, `frontdesk`, `manager`, `qc`, etc.) auto-translate via `normalizeRole` — see [ROLE_MATRIX.md](./ROLE_MATRIX.md).

---

## 3. Helper functions (next-phase)

These are declared in the migration but commented out. They MUST be created and made `SECURITY DEFINER` before any strict policy is enabled.

```sql
create or replace function public.current_user_role() returns text
language sql stable security definer
as $$ select role from public.profiles where id = auth.uid() $$;

create or replace function public.current_user_branch_code() returns text
language sql stable security definer
as $$
  select b.code from public.profiles p
  join public.branches b on b.id = p.branch_id
  where p.id = auth.uid()
$$;
```

Both functions return NULL for anon sessions, which means **every strict policy below denies anon by construction.**

---

## 4. Per-table policy matrix

For each table, this is the contract that the next-phase migration MUST implement.

### 4.1 `branches`

| Operation | owner | hq_admin | branch_manager | front_staff | technician |
|---|---|---|---|---|---|
| SELECT | all rows | all rows | all rows | all rows | all rows |
| INSERT | yes | yes | no | no | no |
| UPDATE | yes | yes | own branch only | no | no |
| DELETE | yes | no | no | no | no |

**Current state:** matches the SELECT row (policy `branches_select_all`). INSERT/UPDATE/DELETE happen only via service role today.

### 4.2 `profiles`

| Operation | owner | hq_admin | branch_manager | front_staff | technician |
|---|---|---|---|---|---|
| SELECT | all rows | all rows | own branch rows | own row only | own row only |
| INSERT | yes | yes | no | no | no |
| UPDATE | yes | yes (except role escalation past hq_admin) | own row + own branch's non-manager rows | own row (name, phone) | own row (name, phone) |
| DELETE | yes (soft via `is_active=false`) | no | no | no | no |

**Current state:** `profiles_self_read` policy (authenticated user sees own row). Writes via service role from the LINE callback.

### 4.3 `orders`

| Operation | owner | hq_admin | branch_manager | front_staff | technician |
|---|---|---|---|---|---|
| SELECT | all | all | own branch | own branch | own branch |
| INSERT | yes | yes | own branch only | own branch only | no |
| UPDATE | yes | yes | own branch | own branch (status + payment) | own branch (status + tech only) |
| DELETE | no — soft cancel via `status='cancelled'` | no | no | no | no |

**Current state:** RLS off. Strict policies (commented in [`supabase/migrations/20260521_enterprise_foundation.sql`](../supabase/migrations/20260521_enterprise_foundation.sql)) implement this matrix.

### 4.4 `customers`

| Operation | owner | hq_admin | branch_manager | front_staff | technician |
|---|---|---|---|---|---|
| SELECT | all | all | own branch + branch_id IS NULL | own branch + branch_id IS NULL | own branch only |
| INSERT | yes | yes | yes (own branch) | yes (own branch) | no |
| UPDATE | yes | yes | own branch | own branch (name, phone, address, email) | no |
| DELETE | no — soft via inactive flag (TBD) | no | no | no | no |

Note: customers with `branch_id IS NULL` represent "chain-wide" customers (e.g. created through CSV import before a branch was selected). Front-staff and branch managers should still be able to look them up — the policy allows reading those rows. Updates must rebind `branch_id` to the current user's branch.

### 4.5 `expense_log` / `branch_expenses`

| Operation | owner | hq_admin | branch_manager | front_staff | technician |
|---|---|---|---|---|---|
| SELECT | all | all | own branch | no | no |
| INSERT | yes | yes | own branch | no | no |
| UPDATE | yes (in audit window) | yes | own branch within 7 days | no | no |
| DELETE | no | no | no | no | no |

### 4.6 `service_prices` (pricing master)

| Operation | owner | hq_admin | branch_manager | front_staff | technician |
|---|---|---|---|---|---|
| SELECT | all | all | all | all | all |
| INSERT | yes | yes | yes (own branch overrides only) | no | no |
| UPDATE | yes | yes | yes (own branch_id rows only) | no | no |
| DELETE | no — disable via `active=false` + `effective_to=now()` | no | no | no | no |

The catalog is read-mostly. Hiding it from front-staff/technicians is a UI concern, not a security one.

### 4.7 `order_audit_log`

| Operation | owner | hq_admin | branch_manager | front_staff | technician |
|---|---|---|---|---|---|
| SELECT | all | all | own branch via join on orders | no | no |
| INSERT | yes (server-side only via service role) | same | same | same | same |
| UPDATE | **forbidden** | **forbidden** | **forbidden** | **forbidden** | **forbidden** |
| DELETE | **forbidden** | **forbidden** | **forbidden** | **forbidden** | **forbidden** |

Audit log is append-only. Any UPDATE / DELETE attempt is a bug; policies must explicitly reject.

### 4.8 `receipts` (future table)

When introduced, mirror `orders` policy exactly — receipts are 1:1 with orders.

---

## 5. Branch-id filtering strategy

Three distinct branch keys exist in the schema and they DO NOT have the same type. Keep this straight:

| Column | Type | What it stores |
|---|---|---|
| `branches.id` | uuid | Primary key. |
| `branches.code` | text unique | Canonical slug — e.g. `c24-thonburi-market`. |
| `branches.short_code` | text | Human prefix — e.g. `C24`, `SLM`. Used in Ezy job IDs. |
| `profiles.branch_id` | **uuid** | References `branches.id`. |
| `orders.branch_id` | **text** | Matches `branches.code`. |
| `customers.branch_id` | **text** | Matches `branches.code`. |

The cross-table join for "which branch is the user in?" is therefore:

```sql
select b.code
from public.profiles p
join public.branches b on b.id = p.branch_id
where p.id = auth.uid();
```

`current_user_branch_code()` encapsulates this and returns the text code. Every RLS policy on orders/customers compares `branch_id = current_user_branch_code()`.

**Long-term plan:** migrate `orders.branch_id` and `customers.branch_id` to uuid. Until then the text-code join is the source of truth.

---

## 6. Next-phase strict policies for orders + customers

The full SQL below ships commented in `20260521_enterprise_foundation.sql`. Uncomment in the auth-bridge migration after switching the cookie session to Supabase Auth.

```sql
alter table public.orders   enable row level security;
alter table public.customers enable row level security;

create policy orders_all_branches on public.orders
  for all to authenticated
  using (current_user_role() in ('owner','hq_admin'))
  with check (current_user_role() in ('owner','hq_admin'));

create policy orders_own_branch on public.orders
  for all to authenticated
  using (current_user_role() in ('branch_manager','front_staff','technician')
         and branch_id = current_user_branch_code())
  with check (current_user_role() in ('branch_manager','front_staff','technician')
         and branch_id = current_user_branch_code());

create policy customers_all_branches on public.customers
  for all to authenticated
  using (current_user_role() in ('owner','hq_admin'))
  with check (current_user_role() in ('owner','hq_admin'));

create policy customers_own_branch on public.customers
  for all to authenticated
  using (current_user_role() in ('branch_manager','front_staff','technician')
         and (branch_id = current_user_branch_code() or branch_id is null))
  with check (current_user_role() in ('branch_manager','front_staff','technician')
         and branch_id = current_user_branch_code());
```

---

## 7. Security principles

1. **Backend enforcement is required.** Every UI guard MUST have a matching DB policy when RLS is fully on. UI-only guards are a UX feature, not a security feature.
2. **Service role is a privilege.** `SUPABASE_SERVICE_ROLE_KEY` lives in server routes only. Never in `"use client"` files, never logged, never returned in API responses.
3. **No "temp grant" policies.** A policy of `using (true)` MUST come with a migration comment naming the migration that removes it and a date target.
4. **Function security.** Helper functions (`current_user_role`, `current_user_branch_code`) are `SECURITY DEFINER` and must `set search_path = public, pg_temp` at definition time to prevent search-path attacks.
5. **Audit before mutation.** When an UPDATE or DELETE is permitted by policy, the corresponding application code must ALSO insert into `order_audit_log` (or its sibling). RLS prevents unauthorised changes; audit log proves authorised changes.
6. **No SELECT-then-mutate races.** Use atomic database operations for anything sensitive — see `generate_ezy_job_id` for the model pattern (single `insert on conflict do update returning`).
7. **Defense in depth.** Frontend gate (`RouteGuard`) + server-side check (route handler that re-reads the session cookie) + RLS. Any single layer can fail.

---

## 8. Testing RLS

After enabling strict policies:

```sql
-- As anon: every read should return zero rows.
set role anon;
select count(*) from public.orders;        -- 0
select count(*) from public.customers;     -- 0

-- As an authenticated user (simulate via Supabase JWT):
-- 1. front_staff in branch X — sees only their branch's orders.
-- 2. owner — sees all rows.
-- 3. front_staff trying to update an order in another branch — gets "new row violates row-level security policy".
```

Automate the above in a Vitest / Playwright suite (next phase).

---

**Last updated:** 2026-05-13 (commit 4805d3b)
