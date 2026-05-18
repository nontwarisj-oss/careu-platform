-- Phase J — Technician work assignment & production queue.
--
-- Additive only. Reuses the existing public.technician_profiles (migration
-- 20260524) as THE technician table — this migration extends it with the
-- remaining Phase J fields and adds two NEW tables (technician_skills,
-- work_assignments). Nothing existing is dropped or destructively altered;
-- the Core Flow, intake, orders, and payroll are untouched.
--
-- Safe to re-run (ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS,
-- idempotent indexes/trigger).

create extension if not exists "pgcrypto";

-- ---------- 1. orders.due_date -------------------------------------------
-- Step 2: reuse a due-date column if one exists; otherwise add it. ADD
-- COLUMN IF NOT EXISTS is a no-op when orders already has due_date (the
-- smart-order schema does), so existing orders keep working untouched.
alter table public.orders add column if not exists due_date date;

-- ---------- 2. technician_profiles — Phase J fields ----------------------
-- Additive: existing technician rows get NULL for the new columns. The
-- intake form's technician picker and the payroll system keep working.
alter table public.technician_profiles add column if not exists phone text;
alter table public.technician_profiles add column if not exists employment_type text;
alter table public.technician_profiles add column if not exists monthly_salary numeric(12, 2);
alter table public.technician_profiles add column if not exists daily_capacity_items integer;
alter table public.technician_profiles add column if not exists note text;

-- ---------- 3. technician_skills -----------------------------------------
-- Richer per-skill rows (with a skill level) on top of the existing flat
-- technician_profiles.skill_tags array. Needed for the urgent-job →
-- ADVANCED/SPECIALIST recommendation.
create table if not exists public.technician_skills (
  id             uuid primary key default gen_random_uuid(),
  technician_id  uuid not null
                 references public.technician_profiles(id) on delete cascade,
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
-- status workflow — distinct from orders.status (the customer-facing
-- ticket status).
create table if not exists public.work_assignments (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete cascade,
  technician_id   uuid not null references public.technician_profiles(id),
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

create or replace function public.touch_work_assignments_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists work_assignments_touch_updated on public.work_assignments;
create trigger work_assignments_touch_updated
  before update on public.work_assignments
  for each row execute function public.touch_work_assignments_updated_at();

-- ---------- 5. RLS --------------------------------------------------------
-- Both new tables run RLS ON with NO policies — the only access path is
-- the service-role Phase J API routes (an anon / authenticated browser
-- client gets nothing). Mirrors public.intake_drafts; existing RLS on
-- technician_profiles / orders is left exactly as-is.
--
-- TODO (technician auth mapping): once technicians have a LINE login,
-- add a policy letting a technician SELECT/UPDATE their own
-- work_assignments rows (technician_id → technician_profiles.user_id =
-- auth.uid()). Until then /technician/my-jobs stays admin-accessible.
alter table public.technician_skills enable row level security;
alter table public.work_assignments enable row level security;

-- ============================================================================
-- Verification:
--   select count(*) from public.work_assignments;   -- 0 initially
--   select count(*) from public.technician_skills;  -- 0 initially
--   \d public.technician_profiles                   -- new columns present
-- ============================================================================
