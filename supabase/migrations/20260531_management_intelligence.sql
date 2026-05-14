-- Management intelligence foundation: customer-tier insight columns +
-- materialised dashboard snapshot for scaling.
--
-- Three additive changes:
--
--   1. public.customers gains lifetime_spend / last_visit_at /
--      primary_branch_id. The tier columns already exist (20260521 added
--      customer_tier / total_orders / latest_service) but they are
--      maintained nowhere — this phase ships the writer
--      (lib/customerTierService.ts).
--
--   2. public.dashboard_daily_snapshot — a *materialised* view keyed by
--      (branch_code, work_date). Holds daily revenue, completed-order
--      count, total-order count, and urgent-order count so the future
--      dashboard reads in O(branches × days) instead of scanning every
--      order row. REFRESH is explicit; refresh_dashboard_daily_snapshot()
--      wraps it so the admin UI + future cron can call one entry point.
--
--   3. refresh_dashboard_daily_snapshot() — SECURITY DEFINER wrapper so a
--      role with EXECUTE on the function can refresh the snapshot
--      without needing the owner of the materialised view.
--
-- The existing branch_monthly_profit view stays unchanged; the new
-- snapshot is daily granularity for the dashboard layer.
--
-- ROLLBACK
--   drop function if exists public.refresh_dashboard_daily_snapshot();
--   drop materialized view if exists public.dashboard_daily_snapshot;
--   alter table public.customers drop column if exists lifetime_spend;
--   alter table public.customers drop column if exists last_visit_at;
--   alter table public.customers drop column if exists primary_branch_id;

create extension if not exists "pgcrypto";

-- ---------- 1. customers.* tier-insight columns ---------------------------

alter table public.customers
  add column if not exists lifetime_spend numeric not null default 0;
alter table public.customers
  add column if not exists last_visit_at  timestamptz;
alter table public.customers
  add column if not exists primary_branch_id text;

create index if not exists customers_last_visit_idx
  on public.customers (last_visit_at desc) where last_visit_at is not null;
create index if not exists customers_lifetime_spend_idx
  on public.customers (lifetime_spend desc);

-- Note: customer_tier (text), total_orders (numeric), latest_service (text)
-- already exist from migration 20260521. We re-use them as the read surface
-- for the tier badge in /customers.

-- ---------- 2. dashboard_daily_snapshot (materialised view) --------------
--
-- Refreshed manually today via refresh_dashboard_daily_snapshot(). A future
-- Supabase Cron / Vercel Cron job will hit /api/admin/dashboard/refresh-snapshot
-- (or call the function directly) on a 15-minute cadence.
--
-- branch_code is the text slug (matches orders.branch_id) so existing
-- branch-isolation patterns transfer without changes.

drop materialized view if exists public.dashboard_daily_snapshot;
create materialized view public.dashboard_daily_snapshot as
select
  o.branch_id                              as branch_code,
  date_trunc('day', o.created_at)::date    as work_date,
  count(*)                                 as total_orders,
  count(*) filter (where o.status = 'completed') as completed_orders,
  count(*) filter (where o.status = 'ready-for-pickup') as ready_orders,
  count(*) filter (where o.urgent is true) as urgent_orders,
  coalesce(sum(case when o.status = 'completed' then o.price else 0 end), 0)
                                            as revenue,
  coalesce(sum(case when o.payment_status = 'paid' then o.price else 0 end), 0)
                                            as paid_revenue,
  coalesce(sum(o.urgent_fee), 0)            as urgent_fee_total,
  coalesce(sum(o.material_cost), 0)         as material_cost_total,
  coalesce(sum(o.labor_cost), 0)            as labor_cost_total
from public.orders o
group by o.branch_id, date_trunc('day', o.created_at)::date
with no data;

create unique index if not exists dashboard_daily_snapshot_pkey
  on public.dashboard_daily_snapshot (branch_code, work_date);

-- ---------- 3. refresh wrapper --------------------------------------------
-- SECURITY DEFINER so authenticated callers (owner / hq_admin going through
-- a server route) can refresh without owning the matview. The route handler
-- is the auth gate; this function itself only enforces "non-anon" because
-- anon hitting it directly would still need EXECUTE — which we don't grant.
--
-- Concurrent refresh requires a unique index — we have one above, so we use
-- the safe variant that never holds an ACCESS EXCLUSIVE lock on the matview
-- while it refreshes.

create or replace function public.refresh_dashboard_daily_snapshot()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  refresh materialized view concurrently public.dashboard_daily_snapshot;
exception when others then
  -- First refresh after WITH NO DATA must be non-concurrent. Fall through
  -- to the non-concurrent path so the very first call from a fresh deploy
  -- succeeds without operator intervention.
  refresh materialized view public.dashboard_daily_snapshot;
end $$;

revoke all on function public.refresh_dashboard_daily_snapshot() from public;
grant execute on function public.refresh_dashboard_daily_snapshot()
  to service_role;

-- RLS doesn't apply to materialised views in PostgreSQL — they're SECURITY
-- INVOKER but bypass per-row policies. The dashboard layer that reads from
-- this view runs through the service-role or the bridge JWT; for branch
-- isolation the consumer applies an `.eq("branch_code", branch_code)` filter
-- after the read. Document this in code at the call site.
--
-- For now: revoke direct read from anon + authenticated and force reads
-- through the service-role client. This keeps a misconfigured client from
-- exposing every branch's daily numbers.

revoke all on public.dashboard_daily_snapshot from public;
revoke all on public.dashboard_daily_snapshot from anon, authenticated;
grant select on public.dashboard_daily_snapshot to service_role;

-- ============================================================================
-- Verification:
--
--   select count(*) from public.dashboard_daily_snapshot;   -- 0 until refresh
--   select public.refresh_dashboard_daily_snapshot();
--   select count(*) from public.dashboard_daily_snapshot;   -- now > 0
--
-- ============================================================================
