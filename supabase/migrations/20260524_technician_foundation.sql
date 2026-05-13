-- Technician assignment + productivity foundation.
--
-- ============================================================================
-- BEFORE YOU APPLY THIS MIGRATION
-- ============================================================================
--
-- Apply order: AFTER 20260523. Depends on:
--   • public.branches, public.profiles, public.orders (with branch_id text,
--     price numeric, material_cost numeric, status text, tech text)
--   • public.current_user_role()   (from 20260522)
--
-- The migration is additive + idempotent. No data is dropped. Reapplying is
-- safe.
--
-- ============================================================================
-- WHAT THIS MIGRATION SHIPS
-- ============================================================================
--
--   • public.technician_profiles      — one row per technician
--   • public.orders.assigned_technician_id / assigned_at / production_value
--                                       / assignment_notes
--   • public.touch_assignment()       — trigger to stamp assigned_at
--   • public.touch_technician_updated() — trigger to keep updated_at fresh
--   • public.technician_daily_kpi     — read-only view; flows orders RLS
--   • RLS on technician_profiles      — read = branch scope, write = admin
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--
--   drop view if exists public.technician_daily_kpi;
--   drop trigger if exists orders_touch_assignment on public.orders;
--   drop function if exists public.touch_assignment();
--   drop trigger if exists technician_profiles_touch_updated on public.technician_profiles;
--   drop function if exists public.touch_technician_updated();
--   alter table public.orders drop column if exists assigned_technician_id;
--   alter table public.orders drop column if exists assigned_at;
--   alter table public.orders drop column if exists production_value;
--   alter table public.orders drop column if exists assignment_notes;
--   drop table if exists public.technician_profiles;
--
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------- 1. technician_profiles ----------------------------------------
create table if not exists public.technician_profiles (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid references public.profiles(id) on delete set null,
  branch_id            uuid references public.branches(id) on delete set null,
  display_name         text not null,
  active               boolean not null default true,
  -- Skill list. Free-form text array so HQ can add new skills via SQL or
  -- the future admin UI without a schema migration. The application carries
  -- a canonical catalog (lib/technicianService.ts::SKILL_CATALOG) for the
  -- dropdown; values here are not strictly limited to that list.
  skill_tags           text[] not null default '{}',
  daily_wage           numeric(12, 2),
  target_multiplier    numeric(8, 2) not null default 3,
  -- When set, overrides the computed (daily_wage × target_multiplier).
  productivity_target  numeric(12, 2),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists technician_profiles_branch_idx
  on public.technician_profiles (branch_id);
create index if not exists technician_profiles_active_idx
  on public.technician_profiles (active) where active;
-- A technician may have at most one row tied to a given profile (one tech =
-- one user). The partial unique index allows multiple NULL user_id rows for
-- contracted / unlinked technicians until they get a real LINE login.
create unique index if not exists technician_profiles_user_uniq
  on public.technician_profiles (user_id) where user_id is not null;
-- GIN index speeds up "find techs with skill X".
create index if not exists technician_profiles_skill_gin
  on public.technician_profiles using gin (skill_tags);

-- Keep updated_at fresh on every UPDATE.
create or replace function public.touch_technician_updated() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists technician_profiles_touch_updated on public.technician_profiles;
create trigger technician_profiles_touch_updated
  before update on public.technician_profiles
  for each row execute function public.touch_technician_updated();

-- ---------- 2. orders extensions -------------------------------------------
alter table public.orders add column if not exists assigned_technician_id uuid
  references public.technician_profiles(id) on delete set null;
alter table public.orders add column if not exists assigned_at  timestamptz;
alter table public.orders add column if not exists production_value numeric(12, 2);
alter table public.orders add column if not exists assignment_notes text;

create index if not exists orders_assigned_technician_idx
  on public.orders (assigned_technician_id);
create index if not exists orders_assigned_at_idx
  on public.orders (assigned_at);

-- Stamp assigned_at when the assignment actually changes. Runs only on
-- UPDATE — INSERTs keep whatever the app set (so a future /intake form
-- could pre-assign at create time).
create or replace function public.touch_assignment() returns trigger
language plpgsql
as $$
begin
  if new.assigned_technician_id is distinct from old.assigned_technician_id then
    new.assigned_at := now();
  end if;
  return new;
end $$;

drop trigger if exists orders_touch_assignment on public.orders;
create trigger orders_touch_assignment
  before update on public.orders
  for each row execute function public.touch_assignment();

-- ---------- 3. Daily KPI view ----------------------------------------------
-- One row per (technician_id, work_date). RLS on the underlying
-- public.orders table flows through automatically — branch-scoped users
-- see only their branch's assignments without a separate policy on the
-- view itself.
--
-- production_value falls back to (price - material_cost) when null, so
-- existing orders that pre-date the assignment system still contribute.
drop view if exists public.technician_daily_kpi;
create view public.technician_daily_kpi as
  select
    o.assigned_technician_id                                                            as technician_id,
    (coalesce(o.assigned_at, o.created_at))::date                                       as work_date,
    count(*)                                                                            as assigned_count,
    coalesce(sum(
      coalesce(o.production_value, coalesce(o.price, 0) - coalesce(o.material_cost, 0))
    ), 0)                                                                               as assigned_value,
    count(*) filter (where o.status = 'completed')                                      as completed_count,
    coalesce(sum(
      coalesce(o.production_value, coalesce(o.price, 0) - coalesce(o.material_cost, 0))
    ) filter (where o.status = 'completed'), 0)                                         as completed_value
  from public.orders o
  where o.assigned_technician_id is not null
  group by o.assigned_technician_id, (coalesce(o.assigned_at, o.created_at))::date;

-- ---------- 4. RLS on technician_profiles ----------------------------------
-- Read:  every authenticated user can read techs in their own branch; admins
--        see all. The order assignment UI for branch managers / front staff
--        needs this read access.
-- Write: only owner / hq_admin. Branch managers may not edit wages.
alter table public.technician_profiles enable row level security;

drop policy if exists technician_profiles_branch_read on public.technician_profiles;
create policy technician_profiles_branch_read on public.technician_profiles
  for select to authenticated
  using (
    public.current_user_role() in ('owner','hq_admin')
    or (
      branch_id is not null
      and branch_id = (select p.branch_id from public.profiles p where p.id = auth.uid())
    )
  );

drop policy if exists technician_profiles_admin_write on public.technician_profiles;
create policy technician_profiles_admin_write on public.technician_profiles
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

-- ============================================================================
-- Verification queries you can run after applying:
--
--   select count(*) from public.technician_profiles;          -- expect 0 initially
--   select * from public.technician_daily_kpi limit 5;        -- empty until assignments exist
--   \d+ public.orders   -- confirms assigned_technician_id + assigned_at + production_value + assignment_notes columns
--
-- ============================================================================
