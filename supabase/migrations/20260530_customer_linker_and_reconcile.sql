-- Customer linker + reconcile foundation.
--
-- Three additive changes:
--
--   1. public.customer_line_links gets `ignored_at` + `ignored_by`. Admins
--      can flag a captured LINE follow as "this isn't a real customer"
--      without unsubscribing the user (unsubscribed_at = the LINE side
--      semantically, ignored_at = the admin side). The unmatched-links UI
--      filters out ignored rows by default.
--
--   2. public.sync_failures.kind CHECK extended with three reconcile kinds:
--        • reconcile_missing_sheet  — order has no Front_Desk row
--        • reconcile_duplicate_sheet — column B has 2+ rows for the same Job
--          ID
--        • reconcile_orphan_link    — customer_line_links row stuck
--          unlinked + un-ignored beyond a threshold
--      Reusing sync_failures lets us inherit the existing recovery UI,
--      branch isolation, retry / resolve flow without inventing a parallel
--      table. The trade-off is semantic: sync_failures historically meant
--      "the platform tried something and it failed" — reconcile items are
--      "the platform noticed a divergence". Both shapes deserve admin
--      attention with the same actions, so the reuse is honest.
--
--   3. public.reconcile_runs records each reconcile invocation (manual or
--      future cron). Mirrors worker_runs from `20260529` so /admin/recovery
--      can show "Last reconcile: 12m ago • 3 mismatches found".
--
-- ROLLBACK
--   alter table public.customer_line_links drop column if exists ignored_at;
--   alter table public.customer_line_links drop column if exists ignored_by;
--   drop table if exists public.reconcile_runs;
--   alter table public.sync_failures drop constraint if exists sync_failures_kind_check;
--   alter table public.sync_failures add constraint sync_failures_kind_check
--     check (kind in (
--       'order_to_sheet','pricing_to_sheet','debug_to_sheet',
--       'customer_from_sheet','expense_from_sheet','line_send','receipt_rebuild'
--     ));

create extension if not exists "pgcrypto";

-- ---------- 1. customer_line_links.ignored_* ------------------------------

alter table public.customer_line_links
  add column if not exists ignored_at timestamptz;
alter table public.customer_line_links
  add column if not exists ignored_by uuid;

-- Partial index so the unmatched-links query stays cheap.
create index if not exists customer_line_links_unmatched_idx
  on public.customer_line_links (created_at desc)
  where customer_id is null and ignored_at is null;

-- ---------- 2. Extend sync_failures.kind ----------------------------------

do $$
declare
  has_old_check boolean;
begin
  select exists (
    select 1
    from pg_constraint
    where conname = 'sync_failures_kind_check'
      and conrelid = 'public.sync_failures'::regclass
  ) into has_old_check;

  if has_old_check then
    alter table public.sync_failures drop constraint sync_failures_kind_check;
  end if;
end $$;

alter table public.sync_failures
  add constraint sync_failures_kind_check
  check (kind in (
    'order_to_sheet',
    'pricing_to_sheet',
    'debug_to_sheet',
    'customer_from_sheet',
    'expense_from_sheet',
    'line_send',
    'receipt_rebuild',
    'reconcile_missing_sheet',
    'reconcile_duplicate_sheet',
    'reconcile_orphan_link'
  ));

-- ---------- 3. reconcile_runs heartbeat -----------------------------------

create table if not exists public.reconcile_runs (
  id                uuid primary key default gen_random_uuid(),
  actor_id          text,
  branch_code       text,
  started_at        timestamptz not null,
  finished_at       timestamptz not null,
  orders_scanned    integer not null default 0,
  missing_sheet     integer not null default 0,
  duplicate_sheet   integer not null default 0,
  orphan_link       integer not null default 0,
  total_mismatches  integer not null default 0,
  /** Per-check summary keyed by check name; useful for postmortem. */
  result            jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists reconcile_runs_created_idx
  on public.reconcile_runs (created_at desc);

alter table public.reconcile_runs enable row level security;

drop policy if exists reconcile_runs_admin_read on public.reconcile_runs;
create policy reconcile_runs_admin_read on public.reconcile_runs
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- Writes go through service-role (admin client) from the reconcile route.
-- No INSERT policy for authenticated users.

-- ============================================================================
-- Verification queries:
--
--   select count(*) from public.reconcile_runs;                    -- expect 0
--   select kind, count(*) from public.sync_failures group by kind; -- new kinds
--                                                                   --   may show
--                                                                   --   up after
--                                                                   --   first run
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='customer_line_links'
--       and column_name in ('ignored_at','ignored_by');             -- 2 rows
--
-- ============================================================================
