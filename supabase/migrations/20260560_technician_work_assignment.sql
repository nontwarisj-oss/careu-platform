-- Phase J — Technician work assignment & production queue.
--
-- SELF-CONTAINED + additive. This migration creates its own technician
-- table (public.technicians) — it does NOT depend on the earlier
-- technician_profiles foundation, which was never applied to this
-- database. Its only dependencies are public.orders and pgcrypto, both of
-- which already exist. Nothing existing is dropped or destructively
-- altered; the Core Flow is untouched.
--
-- Safe to run on the current production database, and safe to re-run
-- (CREATE TABLE / INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- idempotent triggers).

create extension if not exists "pgcrypto";

-- ---------- 1. orders.due_date -------------------------------------------
-- Step 2: reuse a due-date column if one exists; otherwise add it. A no-op
-- when orders already has due_date — existing orders keep working.
alter table public.orders add column if not exists due_date date;

-- ---------- 2. technicians -----------------------------------------------
-- The Phase J technician table. branch_id is the branch CODE SLUG (text),
-- matching public.orders.branch_id — no FK, exactly like orders itself.
create table if not exists public.technicians (
  id                   uuid primary key default gen_random_uuid(),
  branch_id            text,
  name                 text not null,
  phone                text,
  active               boolean not null default true,
  employment_type      text,
  daily_wage           numeric(10, 2),
  monthly_salary       numeric(10, 2),
  target_multiplier    numeric(10, 2) not null default 3,
  daily_capacity_items integer,
  note                 text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists technicians_branch_idx
  on public.technicians (branch_id);
create index if not exists technicians_active_idx
  on public.technicians (active) where active;

-- ---------- 3. technician_skills -----------------------------------------
create table if not exists public.technician_skills (
  id             uuid primary key default gen_random_uuid(),
  technician_id  uuid not null
                 references public.technicians(id) on delete cascade,
  category_th    text,
  subcategory_th text,
  service_code   text,
  skill_level    text not null
                 check (skill_level in ('BASIC','STANDARD','ADVANCED','SPECIALIST')),
  preferred      boolean not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists technician_skills_technician_idx
  on public.technician_skills (technician_id);
create index if not exists technician_skills_service_code_idx
  on public.technician_skills (service_code);
create index if not exists technician_skills_category_idx
  on public.technician_skills (category_th, subcategory_th);

-- ---------- 4. work_assignments ------------------------------------------
-- One row per (order → technician) assignment, with its own production
-- status workflow — distinct from orders.status.
create table if not exists public.work_assignments (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete cascade,
  technician_id   uuid not null references public.technicians(id),
  assigned_date   date not null default current_date,
  due_date        date,
  priority        text not null default 'NORMAL'
                  check (priority in ('NORMAL','URGENT','DUE_SOON')),
  status          text not null default 'ASSIGNED'
                  check (status in
                    ('ASSIGNED','IN_PROGRESS','QC_WAITING','REWORK','DONE','CANCELLED')),
  assigned_by     uuid,
  admin_note      text,
  technician_note text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists work_assignments_order_idx
  on public.work_assignments (order_id);
create index if not exists work_assignments_technician_idx
  on public.work_assignments (technician_id);
create index if not exists work_assignments_assigned_date_idx
  on public.work_assignments (assigned_date);
create index if not exists work_assignments_status_idx
  on public.work_assignments (status);
-- At most one ACTIVE assignment per order (a cancelled one may be replaced).
create unique index if not exists work_assignments_one_active_per_order
  on public.work_assignments (order_id) where status <> 'CANCELLED';

-- ---------- 5. updated_at triggers ---------------------------------------
create or replace function public.touch_phase_j_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists technicians_touch_updated on public.technicians;
create trigger technicians_touch_updated
  before update on public.technicians
  for each row execute function public.touch_phase_j_updated_at();

drop trigger if exists work_assignments_touch_updated on public.work_assignments;
create trigger work_assignments_touch_updated
  before update on public.work_assignments
  for each row execute function public.touch_phase_j_updated_at();

-- ---------- 6. RLS --------------------------------------------------------
-- All three new tables run RLS ON with NO policies — the only access path
-- is the service-role Phase J API routes (an anon / authenticated browser
-- client gets nothing). Mirrors public.intake_drafts; no existing table's
-- RLS is touched.
--
-- TODO (technician auth mapping): when technicians get a LINE login, add a
-- policy letting a technician SELECT/UPDATE their own work_assignments.
alter table public.technicians enable row level security;
alter table public.technician_skills enable row level security;
alter table public.work_assignments enable row level security;

-- ============================================================================
-- Verification:
--   select count(*) from public.technicians;        -- 0 initially
--   select count(*) from public.work_assignments;   -- 0 initially
--   \d public.technicians
-- ============================================================================
