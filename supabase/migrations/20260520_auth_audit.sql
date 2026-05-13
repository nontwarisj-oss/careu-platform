-- Enterprise auth, audit log, job_id, and the system-settings KV.
-- Additive and idempotent — safe to re-run. RLS stays off until policies
-- land in a follow-up migration; the session cookie is authoritative for
-- now (server-only HMAC).
--
-- Builds on 20260516_rbac_finance.sql which created the bare users table.

create extension if not exists "pgcrypto";

-- ---------- users: extend for LINE login + phone fallback -----------------
alter table public.users add column if not exists line_user_id text;
alter table public.users add column if not exists phone        text;
alter table public.users add column if not exists role         text;
alter table public.users add column if not exists branch_id    text;
alter table public.users add column if not exists active       boolean not null default true;
alter table public.users add column if not exists last_login_at timestamptz;
alter table public.users add column if not exists picture_url   text;

-- The 16-05 migration also gave us default_role; line_user_id+phone are the
-- new identity keys. Unique-but-nullable so existing seeded rows survive.
create unique index if not exists users_line_user_id_idx
  on public.users (line_user_id) where line_user_id is not null;
create unique index if not exists users_phone_idx
  on public.users (phone) where phone is not null;
create index if not exists users_branch_id_idx on public.users (branch_id);
create index if not exists users_role_idx       on public.users (role);

-- Re-seed canonical roles to the new enterprise codes. label_th covers the
-- in-app display; the old short codes (frontdesk/manager/executive) are
-- retired in the application layer in this same release.
insert into public.roles (code, label_th, label_en, all_branches) values
  ('CEO',              'CEO',                  'CEO',              true),
  ('AREA_MANAGER',     'ผู้จัดการเขต',          'Area manager',     true),
  ('BRANCH_MANAGER',   'ผู้จัดการสาขา',         'Branch manager',   false),
  ('FRONT_DESK',       'พนักงานหน้าร้าน',       'Front desk',       false),
  ('TECHNICIAN',       'ช่างซ่อม',               'Technician',       false),
  ('ACCOUNTANT',       'บัญชี',                 'Accountant',       true),
  ('FRANCHISE_OWNER',  'เจ้าของแฟรนไชส์',       'Franchise owner',  false)
on conflict (code) do update set
  label_th = excluded.label_th,
  label_en = excluded.label_en,
  all_branches = excluded.all_branches;

-- ---------- orders: human-readable job_id + created_by --------------------
alter table public.orders add column if not exists job_id     text;
alter table public.orders add column if not exists created_by uuid;

create unique index if not exists orders_job_id_unique_idx
  on public.orders (job_id) where job_id is not null;
create index if not exists orders_created_by_idx on public.orders (created_by);

-- ---------- order_audit_log -----------------------------------------------
-- One row per business-meaningful change. Status / payment / cost edits
-- live here so finance + CEO can answer "who did what when". Field-level
-- audit (e.g. customer name typo fix) is intentionally out of scope —
-- noisy, and the existing updated_at on orders covers the casual case.
create table if not exists public.order_audit_log (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders(id) on delete cascade,
  action       text not null check (action in (
                 'created', 'status_changed', 'payment_changed',
                 'cost_updated', 'cancelled', 'sync_pushed'
               )),
  before_value text,
  after_value  text,
  changed_by   uuid references public.users(id) on delete set null,
  changed_at   timestamptz not null default now(),
  note         text
);

create index if not exists order_audit_log_order_idx     on public.order_audit_log (order_id);
create index if not exists order_audit_log_action_idx    on public.order_audit_log (action);
create index if not exists order_audit_log_changed_at_idx on public.order_audit_log (changed_at desc);

alter table public.order_audit_log disable row level security;

-- ---------- system_settings (key/value) -----------------------------------
-- Per-tenant tunables that should live outside code. job_id_mode is the
-- only one for now; add more rows as needed.
create table if not exists public.system_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null
);

alter table public.system_settings disable row level security;

insert into public.system_settings (key, value) values
  ('job_id_mode', 'auto'),       -- 'auto' | 'manual'
  ('job_id_prefix', '')           -- optional prefix prepended to auto IDs
on conflict (key) do nothing;
