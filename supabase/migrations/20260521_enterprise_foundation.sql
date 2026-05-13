-- Enterprise foundation: branches + profiles + business_type + per-branch
-- job_id sequencing + RLS on new tables.
--
-- Design notes
--   * branches.id is uuid (spec), but existing orders.branch_id /
--     customers.branch_id are TEXT slugs ("c24-thonburi-market"). Switching
--     them to uuid is destructive and out of scope here. We therefore add a
--     branches.code TEXT column that matches those slugs and treat code as
--     the cross-table join key. profiles.branch_id IS uuid (clean FK).
--   * RLS is enabled on the NEW tables (branches, profiles). It stays OFF on
--     orders / customers in THIS migration because the active session layer
--     is LINE-login + HMAC cookie, not Supabase Auth — turning RLS on with
--     auth.uid() policies would 0-out every existing query. The strict
--     policies are written below as commented-out SQL so the next migration
--     can flip them once the Supabase Auth bridge ships.
--   * Idempotent + additive; safe to re-run.
--   * Backfill rules below are conservative (default to 'care_u') because
--     legacy rows have no explicit business_type signal.

create extension if not exists "pgcrypto";

-- ---------- branches -------------------------------------------------------
create table if not exists public.branches (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,             -- canonical slug, matches orders.branch_id
  short_code  text not null,                    -- human prefix for Ezy job_id: "C24", "SLM", "BTS01"
  name        text not null,
  type        text not null default 'mixed' check (type in ('care_u','ezy_repair','mixed')),
  brand       text,                              -- 'careu' | 'ezy' — informational
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists branches_active_idx on public.branches (is_active);

-- Seed from the hardcoded brandConfig.ts. Re-running is safe.
insert into public.branches (code, short_code, name, type, brand) values
  ('c24-thonburi-market',  'C24', 'C24 Care U - ตลาดสดธนบุรี',          'care_u',     'careu'),
  ('ezy-repair-saladaeng', 'SLM', 'Ezy Repair by Care U - BTS ศาลาแดง', 'ezy_repair', 'ezy')
on conflict (code) do update set
  short_code = excluded.short_code,
  name = excluded.name,
  type = excluded.type,
  brand = excluded.brand;

-- ---------- profiles -------------------------------------------------------
-- profiles.id intentionally matches the existing public.users.id, so when
-- Supabase Auth lands the same UUID can be reused as auth.users.id.
create table if not exists public.profiles (
  id            uuid primary key,                -- = auth.users.id once Supabase Auth is wired
  auth_user_id  uuid,                            -- nullable bridge to auth.users until then
  full_name     text,
  phone         text,
  line_user_id  text,
  role          text not null default 'front_staff',
  branch_id     uuid references public.branches(id) on delete set null,
  is_active     boolean not null default true,
  last_login_at timestamptz,
  picture_url   text,
  created_at    timestamptz not null default now()
);

create unique index if not exists profiles_line_user_id_idx
  on public.profiles (line_user_id) where line_user_id is not null;
create unique index if not exists profiles_phone_idx
  on public.profiles (phone) where phone is not null;
create unique index if not exists profiles_auth_user_id_idx
  on public.profiles (auth_user_id) where auth_user_id is not null;
create index if not exists profiles_branch_idx on public.profiles (branch_id);
create index if not exists profiles_role_idx   on public.profiles (role);

-- Backfill profiles from the existing users table created by 20260516.
-- branch_id text → uuid via branches.code lookup; role normalised by the app.
insert into public.profiles (
  id, full_name, phone, line_user_id, role, branch_id, is_active, picture_url, last_login_at, created_at
)
select
  u.id,
  u.display_name,
  u.phone,
  u.line_user_id,
  coalesce(u.role, 'front_staff'),
  b.id,
  coalesce(u.active, true),
  u.picture_url,
  u.last_login_at,
  u.created_at
from public.users u
left join public.branches b on b.code = u.branch_id
on conflict (id) do nothing;

-- ---------- orders: business_type + due_date + tech ----------------------
alter table public.orders add column if not exists business_type text;
alter table public.orders add column if not exists due_date      date;
alter table public.orders add column if not exists tech          text;

-- Backfill business_type using branch type (Ezy branch → ezy_repair, else care_u).
update public.orders o
set business_type = case
    when b.type = 'ezy_repair' then 'ezy_repair'
    else 'care_u'
  end
from public.branches b
where o.branch_id = b.code
  and o.business_type is null;

update public.orders set business_type = 'care_u' where business_type is null;

alter table public.orders alter column business_type set default 'care_u';
alter table public.orders alter column business_type set not null;

-- Constrain to known values.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_business_type_check'
  ) then
    alter table public.orders
      add constraint orders_business_type_check
      check (business_type in ('care_u','ezy_repair'));
  end if;
end $$;

create index if not exists orders_business_type_idx on public.orders (business_type);
create index if not exists orders_due_date_idx      on public.orders (due_date);
create index if not exists orders_tech_idx          on public.orders (tech);

-- The old global-unique index on job_id is too strict — Care U manual ids
-- only need to be unique per (branch, business_type). Replace it.
drop index if exists orders_job_id_unique_idx;
create unique index if not exists orders_job_id_scoped_idx
  on public.orders (branch_id, business_type, job_id) where job_id is not null;

-- ---------- customers: enrichment columns ---------------------------------
alter table public.customers add column if not exists normalized_name text;
alter table public.customers add column if not exists total_orders    numeric not null default 0;
alter table public.customers add column if not exists latest_service  text;
alter table public.customers add column if not exists customer_tier   text;

-- Backfill normalized_name as the trimmed lowercase form. Cheap server-side
-- shape that's good enough for dedup until a richer normalizer lands.
update public.customers
set normalized_name = lower(btrim(coalesce(name, '')))
where normalized_name is null or normalized_name = '';

create index if not exists customers_normalized_name_idx on public.customers (normalized_name);
create index if not exists customers_tier_idx            on public.customers (customer_tier);

-- ---------- Ezy daily sequence + generator --------------------------------
create table if not exists public.job_id_sequence (
  branch_code   text not null,
  business_type text not null,
  for_date      date not null,
  last_seq      integer not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (branch_code, business_type, for_date)
);

-- Atomic increment via insert-on-conflict. Concurrency safe: Postgres
-- serialises the upsert per primary key.
create or replace function public.generate_ezy_job_id(p_branch text)
returns text
language plpgsql
as $$
declare
  v_short_code text;
  v_today      date := current_date;
  v_seq        integer;
begin
  -- Accept either a branches.id (uuid as text) OR a branches.code slug.
  select short_code into v_short_code
  from public.branches
  where code = p_branch
     or id::text = p_branch
  limit 1;

  if v_short_code is null then
    v_short_code := upper(coalesce(p_branch, 'UNK'));
  end if;

  insert into public.job_id_sequence (branch_code, business_type, for_date, last_seq, updated_at)
  values (v_short_code, 'ezy_repair', v_today, 1, now())
  on conflict (branch_code, business_type, for_date) do update
    set last_seq = public.job_id_sequence.last_seq + 1,
        updated_at = now()
  returning last_seq into v_seq;

  return v_short_code || '-' || to_char(v_today, 'YYMMDD') || '-' || lpad(v_seq::text, 3, '0');
end;
$$;

-- ---------- Re-seed public.roles to the new 5-role spec -------------------
-- The legacy 7 codes (CEO, AREA_MANAGER, …) stay in the table so any
-- audit_log row still resolves; the app maps them to the 5 enterprise codes
-- via lib/roles.ts::normalizeRole.
insert into public.roles (code, label_th, label_en, all_branches) values
  ('owner',          'Owner',                'Owner',           true),
  ('hq_admin',       'แอดมินสำนักงานใหญ่',    'HQ admin',        true),
  ('branch_manager', 'ผู้จัดการสาขา',         'Branch manager',  false),
  ('front_staff',    'พนักงานหน้าร้าน',       'Front staff',     false),
  ('technician',     'ช่างซ่อม',               'Technician',      false)
on conflict (code) do update set
  label_th = excluded.label_th,
  label_en = excluded.label_en,
  all_branches = excluded.all_branches;

-- ---------- RLS on new tables ---------------------------------------------
-- branches: readable by everyone (it's reference data); writable only with
-- service-role (no policy = no INSERT/UPDATE/DELETE for anon/authenticated).
alter table public.branches enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'branches' and policyname = 'branches_select_all'
  ) then
    create policy branches_select_all on public.branches
      for select to anon, authenticated using (true);
  end if;
end $$;

-- profiles: only the service-role + the row owner can read. The LINE
-- callback and /api/auth/me use the service-role client (lib/supabaseAdmin),
-- so this policy denies the anon client by default — correct behavior.
alter table public.profiles enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_self_read'
  ) then
    create policy profiles_self_read on public.profiles
      for select to authenticated using (id = auth.uid());
  end if;
end $$;
-- (service-role bypasses RLS by design.)

-- job_id_sequence: state owned by the generator. Lock down all client access.
alter table public.job_id_sequence enable row level security;
-- No policies → only service-role can touch it. The generate_ezy_job_id
-- function is SECURITY INVOKER so callers need DB privileges, but in
-- Supabase the function is callable by anon/authenticated via RPC and the
-- SECURITY DEFINER pattern can be added later if needed.

-- ---------- Next-phase strict RLS for orders + customers ------------------
-- These are intentionally NOT enabled yet — current sessions are LINE-cookie
-- based, not Supabase Auth, so auth.uid() returns NULL and the policies
-- would deny every read. After the Supabase Auth bridge migration lands,
-- uncomment + apply this block:
--
-- create or replace function public.current_user_role() returns text
-- language sql stable security definer
-- as $$ select role from public.profiles where id = auth.uid() $$;
--
-- create or replace function public.current_user_branch_code() returns text
-- language sql stable security definer
-- as $$
--   select b.code from public.profiles p
--   join public.branches b on b.id = p.branch_id
--   where p.id = auth.uid()
-- $$;
--
-- alter table public.orders   enable row level security;
-- alter table public.customers enable row level security;
--
-- create policy orders_all_branches on public.orders
--   for all to authenticated
--   using (current_user_role() in ('owner','hq_admin'))
--   with check (current_user_role() in ('owner','hq_admin'));
--
-- create policy orders_own_branch on public.orders
--   for all to authenticated
--   using (current_user_role() in ('branch_manager','front_staff','technician')
--          and branch_id = current_user_branch_code())
--   with check (current_user_role() in ('branch_manager','front_staff','technician')
--          and branch_id = current_user_branch_code());
--
-- (mirror for customers)
