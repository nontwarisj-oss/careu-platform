-- Internal staff login — employee_code + password.
--
-- Care U OPS originally authenticated operators through LINE Login. This
-- migration adds a self-contained internal login: a dedicated credentials
-- table that the /api/auth/staff/* routes read with the service-role client.
--
-- RLS is ENABLED with NO policy on purpose — the same pattern as intake_drafts
-- and the Phase J tables. The browser anon client can therefore never read
-- password_hash; the only access path is the server (service-role) routes.
--
-- Additive + idempotent. Depends only on existing tables.

create extension if not exists "pgcrypto";

create table if not exists public.staff_accounts (
  id            uuid primary key default gen_random_uuid(),
  employee_code text not null,
  password_hash text not null,
  full_name     text not null,
  role          text not null default 'front_staff'
    check (role in ('owner', 'hq_admin', 'branch_manager', 'front_staff', 'technician')),
  -- branch code slug — same value space as orders.branch_id / users.branch_id.
  -- No FK: branches keying has drifted across migrations; the app validates.
  branch_id     text,
  active        boolean not null default true,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- employee_code is stored lower-cased by the API; the functional unique index
-- is a second line of defence against a mixed-case duplicate slipping in.
create unique index if not exists staff_accounts_employee_code_idx
  on public.staff_accounts (lower(employee_code));

create index if not exists staff_accounts_branch_idx
  on public.staff_accounts (branch_id);

alter table public.staff_accounts enable row level security;
-- (intentionally no policy → service-role routes are the only access path)

-- order_audit_log.changed_by FKs public.users(id). Staff-account ids live in
-- staff_accounts, so a staff-driven audit row would violate that FK and be
-- dropped. The audit insert is already best-effort; relax the constraint to a
-- plain uuid column so payment / status changes by staff still get recorded.
alter table public.order_audit_log
  drop constraint if exists order_audit_log_changed_by_fkey;
