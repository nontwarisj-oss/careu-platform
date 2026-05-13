-- RBAC skeleton + financial fields, prepared but not enforced.
-- Idempotent / additive — applying this is non-destructive and leaves all
-- existing operations working. RLS is intentionally OFF on every new table;
-- when real auth lands we'll add policies in a separate migration.

create extension if not exists "pgcrypto";

-- ---------- Financial extension on public.orders --------------------------
alter table public.orders add column if not exists cost_estimate  numeric(12, 2);
alter table public.orders add column if not exists labor_cost     numeric(12, 2);
alter table public.orders add column if not exists material_cost  numeric(12, 2);

-- ---------- Branch-level expense tracking ---------------------------------
create table if not exists public.branch_expenses (
  id            uuid primary key default gen_random_uuid(),
  branch_id     text not null,
  category      text not null,           -- labor / materials / rent / equipment / advertising / admin / other
  amount        numeric(12, 2) not null default 0,
  description   text,
  occurred_on   date not null default current_date,
  created_at    timestamptz not null default now()
);

create index if not exists branch_expenses_branch_idx   on public.branch_expenses (branch_id);
create index if not exists branch_expenses_occurred_idx on public.branch_expenses (occurred_on);

alter table public.branch_expenses disable row level security;

-- ---------- Role-based access skeleton ------------------------------------
-- These tables capture the model that future Supabase Auth + RLS will plug
-- into. For now they sit empty; the frontend uses lib/roles.ts as the local
-- source of truth so we can preview each role without auth wired up.

create table if not exists public.roles (
  code         text primary key,         -- 'frontdesk', 'technician', 'qc', 'accounting', 'manager', 'executive', 'admin'
  label_th     text not null,
  label_en     text not null,
  all_branches boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists public.permissions (
  code        text primary key,
  label_th    text not null,
  description text,
  created_at  timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role_code       text not null references public.roles(code) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  primary key (role_code, permission_code)
);

-- Application users — separate from auth.users so we can pre-populate
-- before Supabase Auth lands. Once auth is wired, link via auth_user_id.
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid,
  email         text,
  display_name  text not null,
  default_role  text references public.roles(code),
  created_at    timestamptz not null default now()
);

create unique index if not exists users_email_idx        on public.users (lower(email)) where email is not null;
create unique index if not exists users_auth_user_id_idx on public.users (auth_user_id) where auth_user_id is not null;

-- Which branches each user can see / operate in. A user with no rows here
-- but a role with all_branches=true sees every branch.
create table if not exists public.user_branch_access (
  user_id    uuid not null references public.users(id) on delete cascade,
  branch_id  text not null,
  role_code  text references public.roles(code),
  created_at timestamptz not null default now(),
  primary key (user_id, branch_id)
);

create index if not exists user_branch_access_branch_idx on public.user_branch_access (branch_id);

alter table public.roles                disable row level security;
alter table public.permissions          disable row level security;
alter table public.role_permissions     disable row level security;
alter table public.users                disable row level security;
alter table public.user_branch_access   disable row level security;

-- Seed the canonical role list so it matches lib/roles.ts even though the
-- frontend doesn't read from it yet. Safe to re-run.
insert into public.roles (code, label_th, label_en, all_branches) values
  ('frontdesk',  'พนักงานหน้าร้าน', 'Front desk',  false),
  ('technician', 'ช่างซ่อม',         'Technician',  false),
  ('qc',         'QC',                'QC',          false),
  ('accounting', 'บัญชี',             'Accounting',  true),
  ('manager',    'ผู้จัดการสาขา',     'Manager',     false),
  ('executive',  'ผู้บริหาร (CEO)',   'Executive',   true),
  ('admin',      'ผู้ดูแลระบบ',       'Admin',       true)
on conflict (code) do update set
  label_th = excluded.label_th,
  label_en = excluded.label_en,
  all_branches = excluded.all_branches;
