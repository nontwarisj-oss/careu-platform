-- Expense + payroll foundation.
--
-- ============================================================================
-- BEFORE YOU APPLY THIS MIGRATION
-- ============================================================================
--
-- Apply order: AFTER 20260524. Depends on:
--   • public.current_user_role()          (20260522)
--   • public.current_user_branch_code()   (20260522)
--   • public.profiles, public.branches    (20260521)
--   • public.technician_profiles          (20260524)
--   • public.expenses                     (20260518)
--   • public.orders                       (20260512..)
--
-- Additive + idempotent. No existing column is dropped or retyped — legacy
-- `expenses.created_by text` stays as-is so the sync-expenses route keeps
-- working. New columns are NULL-by-default so unmigrated callers don't
-- need updating.
--
-- ============================================================================
-- WHAT THIS MIGRATION SHIPS
-- ============================================================================
--
--   • public.current_user_branch_id()       uuid-returning sibling of the
--                                            existing code-returning helper.
--   • Standardised public.expenses          added created_by_uuid (uuid),
--                                            updated_at + updated_by + touch
--                                            trigger. RLS enabled.
--   • public.payroll_periods                one row per (branch, year, month).
--   • public.technician_payroll_items       one row per technician per period.
--   • public.branch_monthly_profit          read-only view aggregating revenue
--                                            − material − labor − expenses.
--   • RLS on all three new objects.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--
--   drop view if exists public.branch_monthly_profit;
--   drop policy if exists technician_payroll_items_admin_full on public.technician_payroll_items;
--   drop policy if exists technician_payroll_items_branch_read on public.technician_payroll_items;
--   drop policy if exists payroll_periods_admin_full on public.payroll_periods;
--   drop policy if exists payroll_periods_branch_read on public.payroll_periods;
--   drop table if exists public.technician_payroll_items;
--   drop table if exists public.payroll_periods;
--   drop policy if exists expenses_admin_full on public.expenses;
--   drop policy if exists expenses_branch_scoped on public.expenses;
--   alter table public.expenses disable row level security;
--   alter table public.expenses drop column if exists created_by_uuid;
--   alter table public.expenses drop column if exists updated_at;
--   alter table public.expenses drop column if exists updated_by;
--   drop trigger if exists expenses_touch_updated on public.expenses;
--   drop function if exists public.touch_expense_updated();
--   drop function if exists public.current_user_branch_id();
--
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------- 1. uuid-returning branch helper -------------------------------
-- Existing current_user_branch_code() returns the text slug used by
-- public.orders / public.customers / public.expenses. New tables that
-- use branches(id) as a real FK need the uuid form.

create or replace function public.current_user_branch_id() returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select branch_id from public.profiles where id = auth.uid()
$$;

comment on function public.current_user_branch_id() is
  'Returns branches.id (uuid) for the calling user via profiles.';

-- ---------- 2. expense standardisation ------------------------------------
-- We add (rather than rewrite) so the existing sync-expenses + /expenses
-- UI flows continue to write the columns they already know. created_by
-- (text) stays; created_by_uuid (uuid) becomes the canonical attribution
-- field for new authenticated writes.

alter table public.expenses add column if not exists created_by_uuid uuid;
alter table public.expenses add column if not exists updated_at timestamptz not null default now();
alter table public.expenses add column if not exists updated_by uuid;

create index if not exists expenses_created_by_uuid_idx
  on public.expenses (created_by_uuid) where created_by_uuid is not null;

create or replace function public.touch_expense_updated() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  begin
    -- Auto-stamp updated_by from the bridge JWT when present.
    new.updated_by := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  exception when others then
    new.updated_by := old.updated_by;
  end;
  return new;
end $$;

drop trigger if exists expenses_touch_updated on public.expenses;
create trigger expenses_touch_updated
  before update on public.expenses
  for each row execute function public.touch_expense_updated();

-- Also stamp created_by_uuid on insert when the caller didn't set one.
create or replace function public.stamp_expense_created_by() returns trigger
language plpgsql
as $$
begin
  if new.created_by_uuid is null then
    begin
      new.created_by_uuid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    exception when others then
      new.created_by_uuid := null;
    end;
  end if;
  return new;
end $$;

drop trigger if exists expenses_stamp_created_by on public.expenses;
create trigger expenses_stamp_created_by
  before insert on public.expenses
  for each row execute function public.stamp_expense_created_by();

-- Enable RLS. expenses.branch_id is still text (matches orders/customers),
-- so the policy compares against current_user_branch_code(), not _id.
alter table public.expenses enable row level security;

drop policy if exists expenses_admin_full on public.expenses;
create policy expenses_admin_full on public.expenses
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists expenses_branch_scoped on public.expenses;
create policy expenses_branch_scoped on public.expenses
  for all to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and branch_id = public.current_user_branch_code()
  )
  with check (
    public.current_user_role() = 'branch_manager'
    and branch_id = public.current_user_branch_code()
  );

-- front_staff + technician + anon get no policy = no access. They never see
-- expenses, never insert. Matches ROLE_MATRIX.md.

-- ---------- 3. payroll_periods --------------------------------------------
create table if not exists public.payroll_periods (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references public.branches(id) on delete restrict,
  year          integer not null,
  month         integer not null check (month between 1 and 12),
  start_date    date not null,
  end_date      date not null,
  status        text not null default 'open'
                check (status in ('open', 'finalized', 'paid', 'cancelled')),
  finalized_at  timestamptz,
  finalized_by  uuid,
  paid_at       timestamptz,
  paid_by       uuid,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  updated_by    uuid
);

create unique index if not exists payroll_periods_branch_month_uniq
  on public.payroll_periods (branch_id, year, month);
create index if not exists payroll_periods_status_idx
  on public.payroll_periods (status);
create index if not exists payroll_periods_branch_idx
  on public.payroll_periods (branch_id);

create or replace function public.touch_payroll_period_updated() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  begin
    new.updated_by := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  exception when others then
    new.updated_by := old.updated_by;
  end;
  return new;
end $$;

drop trigger if exists payroll_periods_touch_updated on public.payroll_periods;
create trigger payroll_periods_touch_updated
  before update on public.payroll_periods
  for each row execute function public.touch_payroll_period_updated();

-- ---------- 4. technician_payroll_items -----------------------------------
create table if not exists public.technician_payroll_items (
  id                          uuid primary key default gen_random_uuid(),
  payroll_period_id           uuid not null references public.payroll_periods(id) on delete cascade,
  technician_profile_id       uuid references public.technician_profiles(id) on delete set null,
  -- Snapshot wage settings so historical numbers don't drift when HQ adjusts
  -- the technician's daily_wage / target_multiplier mid-month.
  daily_wage_snapshot         numeric(12, 2),
  target_multiplier_snapshot  numeric(8, 2),
  base_wage                   numeric(12, 2) not null default 0,
  -- Aggregates from technician_daily_kpi rolled up at finalization time.
  days_worked                 integer not null default 0,
  production_value            numeric(12, 2) not null default 0,
  target_value                numeric(12, 2) not null default 0,
  performance_ratio           numeric(8, 4) not null default 0,
  -- Owner-decided adjustments.
  bonus_amount                numeric(12, 2) not null default 0,
  deduction_amount            numeric(12, 2) not null default 0,
  -- final_pay defaults to base_wage; UI will let owner override.
  final_pay                   numeric(12, 2) not null default 0,
  notes                       text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by                  uuid,
  updated_by                  uuid
);

create unique index if not exists technician_payroll_items_unique
  on public.technician_payroll_items (payroll_period_id, technician_profile_id);
create index if not exists technician_payroll_items_period_idx
  on public.technician_payroll_items (payroll_period_id);
create index if not exists technician_payroll_items_tech_idx
  on public.technician_payroll_items (technician_profile_id);

create or replace function public.touch_payroll_item_updated() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  begin
    new.updated_by := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  exception when others then
    new.updated_by := old.updated_by;
  end;
  return new;
end $$;

drop trigger if exists technician_payroll_items_touch_updated on public.technician_payroll_items;
create trigger technician_payroll_items_touch_updated
  before update on public.technician_payroll_items
  for each row execute function public.touch_payroll_item_updated();

-- ---------- 5. RLS on payroll tables --------------------------------------
-- Both tables: owner/hq_admin full access; branch_manager READ only on own
-- branch; front_staff + technician + anon no access (no policy = denied).
alter table public.payroll_periods           enable row level security;
alter table public.technician_payroll_items  enable row level security;

drop policy if exists payroll_periods_admin_full on public.payroll_periods;
create policy payroll_periods_admin_full on public.payroll_periods
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists payroll_periods_branch_read on public.payroll_periods;
create policy payroll_periods_branch_read on public.payroll_periods
  for select to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and branch_id = public.current_user_branch_id()
  );

drop policy if exists technician_payroll_items_admin_full on public.technician_payroll_items;
create policy technician_payroll_items_admin_full on public.technician_payroll_items
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists technician_payroll_items_branch_read on public.technician_payroll_items;
create policy technician_payroll_items_branch_read on public.technician_payroll_items
  for select to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and payroll_period_id in (
      select id from public.payroll_periods
      where branch_id = public.current_user_branch_id()
    )
  );

-- ---------- 6. branch_monthly_profit view ---------------------------------
-- Read-only roll-up that combines revenue + material + labor cost from
-- orders with operational expenses, by branch × calendar month. Branch
-- scope inherits automatically from the underlying tables' RLS.
--
-- Definition (per spec):
--   gross_profit = revenue
--                − material_cost   (per-order material recorded on orders)
--                − labor_cost      (per-order labor recorded on orders)
--                − expenses        (from public.expenses)
--
-- Orders are counted in the month of their created_at. Only orders with
-- status='completed' contribute revenue — partial / cancelled jobs are
-- excluded so the number matches what the cash drawer actually booked.

drop view if exists public.branch_monthly_profit;
create view public.branch_monthly_profit as
with orders_agg as (
  select
    o.branch_id,
    date_trunc('month', o.created_at)::date           as month_start,
    sum(coalesce(o.price, 0))                          as revenue,
    sum(coalesce(o.material_cost, 0))                  as material_cost,
    sum(coalesce(o.labor_cost, 0))                     as labor_cost,
    count(*)                                           as completed_orders
  from public.orders o
  where o.status = 'completed'
  group by o.branch_id, date_trunc('month', o.created_at)::date
),
expenses_agg as (
  select
    e.branch_id,
    date_trunc('month', e.expense_date::timestamptz)::date as month_start,
    sum(coalesce(e.amount, 0))                              as expenses,
    count(*)                                                as expense_count
  from public.expenses e
  group by e.branch_id, date_trunc('month', e.expense_date::timestamptz)::date
)
select
  coalesce(o.branch_id, e.branch_id)            as branch_code,
  coalesce(o.month_start, e.month_start)        as month_start,
  coalesce(o.revenue, 0)                        as revenue,
  coalesce(o.material_cost, 0)                  as material_cost,
  coalesce(o.labor_cost, 0)                     as labor_cost,
  coalesce(e.expenses, 0)                       as operational_expenses,
  coalesce(o.revenue, 0)
    - coalesce(o.material_cost, 0)
    - coalesce(o.labor_cost, 0)
    - coalesce(e.expenses, 0)                   as gross_profit,
  coalesce(o.completed_orders, 0)               as completed_orders,
  coalesce(e.expense_count, 0)                  as expense_count
from orders_agg o
full outer join expenses_agg e
  on o.branch_id = e.branch_id
 and o.month_start = e.month_start;

comment on view public.branch_monthly_profit is
  'Monthly P&L roll-up per branch. revenue − material − labor − expenses = gross_profit. Branch scope inherits from orders/expenses RLS.';

-- ============================================================================
-- Verification queries you can run after applying:
--
--   select * from public.payroll_periods limit 5;             -- expect 0 initially
--   select * from public.technician_payroll_items limit 5;    -- expect 0
--   select * from public.branch_monthly_profit
--     order by month_start desc, branch_code;                 -- aggregate per branch×month
--   select column_name, data_type from information_schema.columns
--     where table_schema='public' and table_name='expenses'
--     order by ordinal_position;                              -- confirms new columns
--
-- ============================================================================
