-- Auth bridge + strict RLS activation.
--
-- ============================================================================
-- BEFORE YOU APPLY THIS MIGRATION
-- ============================================================================
--
-- This migration turns RLS into the *real* enforcement layer for orders and
-- customers. Before applying, the following env vars MUST be set in Vercel
-- (or whatever environment serves traffic) and the app MUST be redeployed:
--
--     SUPABASE_JWT_SECRET           = Project Settings → API → "JWT Secret"
--     SUPABASE_SERVICE_ROLE_KEY     = (already required from 20260521)
--     SESSION_SECRET                = (already required for cookie session)
--     LINE_LOGIN_CHANNEL_ID/SECRET  = (already required for login)
--
-- If those are missing, applying this migration will deny every anon read of
-- orders / customers — staff will see empty lists. That's RLS doing its job,
-- but it will look like a regression. Set the vars first, redeploy, then run.
--
-- The bridge does NOT create rows in auth.users. PostgREST validates the JWT
-- signature against SUPABASE_JWT_SECRET and exposes the `sub` claim via
-- auth.uid() — it does not require a matching auth.users row. We use
-- profiles.id as the JWT subject, so auth.uid() = profiles.id directly.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--
-- To undo:
--     drop policy if exists orders_admin_full      on public.orders;
--     drop policy if exists orders_branch_scoped   on public.orders;
--     drop policy if exists customers_admin_full   on public.customers;
--     drop policy if exists customers_branch_scoped on public.customers;
--     drop policy if exists profiles_admin_read    on public.profiles;
--     drop policy if exists profiles_branch_read   on public.profiles;
--     alter table public.orders   disable row level security;
--     alter table public.customers disable row level security;
--     drop function if exists public.current_user_role();
--     drop function if exists public.current_user_branch_code();
--
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------- Helper functions ----------------------------------------------
-- Both functions are SECURITY DEFINER with a locked search_path so a caller
-- cannot redirect them at a shadow table. They return NULL for anon sessions
-- (auth.uid() is NULL), which by construction denies every strict policy.

create or replace function public.current_user_role() returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.current_user_branch_code() returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select b.code
  from public.profiles p
  join public.branches b on b.id = p.branch_id
  where p.id = auth.uid()
$$;

comment on function public.current_user_role() is
  'Returns the role of the calling user (via JWT sub → profiles.id). NULL for anon.';
comment on function public.current_user_branch_code() is
  'Returns branches.code for the calling user. NULL for anon or unscoped users.';

-- ---------- profiles: admin + branch-manager read policies ----------------
-- (profiles_self_read from 20260521 already lets a user read their own row.)

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='profiles' and policyname='profiles_admin_read'
  ) then
    create policy profiles_admin_read on public.profiles
      for select to authenticated
      using (public.current_user_role() in ('owner','hq_admin'));
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='profiles' and policyname='profiles_branch_read'
  ) then
    create policy profiles_branch_read on public.profiles
      for select to authenticated
      using (
        public.current_user_role() = 'branch_manager'
        and branch_id = (
          select p.branch_id from public.profiles p where p.id = auth.uid()
        )
      );
  end if;
end $$;

-- ---------- orders: strict RLS --------------------------------------------
alter table public.orders enable row level security;

drop policy if exists orders_admin_full on public.orders;
create policy orders_admin_full on public.orders
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists orders_branch_scoped on public.orders;
create policy orders_branch_scoped on public.orders
  for all to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff','technician')
    and branch_id = public.current_user_branch_code()
  )
  with check (
    public.current_user_role() in ('branch_manager','front_staff','technician')
    and branch_id = public.current_user_branch_code()
  );

-- ---------- customers: strict RLS -----------------------------------------
-- branch-scoped roles see their branch + chain-wide rows (branch_id IS NULL).
-- They may only write rows pinned to their branch (`with check` is stricter
-- than `using`).
alter table public.customers enable row level security;

drop policy if exists customers_admin_full on public.customers;
create policy customers_admin_full on public.customers
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists customers_branch_scoped on public.customers;
create policy customers_branch_scoped on public.customers
  for all to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff','technician')
    and (branch_id = public.current_user_branch_code() or branch_id is null)
  )
  with check (
    public.current_user_role() in ('branch_manager','front_staff','technician')
    and branch_id = public.current_user_branch_code()
  );

-- ---------- order_audit_log: keep server-side write only ------------------
-- The audit log is written from server routes via the service-role client.
-- RLS stays off here intentionally — adding it would require duplicating the
-- branch scope rules from orders, and the table is already write-restricted
-- by the application (audit code paths only).
--
-- A future migration may flip this on with a SELECT-only policy mirroring
-- the orders branch scope so managers can render the timeline directly.

-- ---------- service_prices + branch_expenses ------------------------------
-- service_prices is read-mostly catalog data — fine to leave RLS off until
-- the next pricing migration (which has its own audit + versioning rules).
-- branch_expenses already lives under a manager-only UI; the financial-
-- visibility rule (canSeeFinancials) gates it client-side. RLS flip lands
-- alongside the dashboard / reports refactor.

-- ============================================================================
-- Verification queries you can run after applying:
--
--   set role anon; select count(*) from public.orders;           -- expect 0
--   set role authenticated;
--   -- (Cannot meaningfully test without a JWT; verify via the app UI.)
--
-- ============================================================================
