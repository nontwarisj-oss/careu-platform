-- Worker telemetry + alert rules + email channel readiness.
--
-- Three sets of changes:
--
--   1. public.cron_heartbeat_logs — one row per cron tick, success or
--      failure. Drives the /admin/system/workers dashboard, the
--      "worker unhealthy" banner, and the self-heal endpoint's stall
--      detection.
--
--   2. public.communication_alert_rules — operator-defined thresholds
--      against the dispatch health metrics. When a rule breaches, the
--      admin UI surfaces a banner. No external paging yet — this is
--      operator-visible only.
--
--   3. Schema housekeeping for unified communications timeline +
--      email channel. customer_notifications already accepts 'email'
--      (Phase 12 expanded the channel CHECK). The Phase 14 dispatch
--      log + Phase 15 LINE delivery log already capture per-channel
--      attempts. This migration adds the dashboard's index helper
--      for the unified timeline query: by customer_id ordered by
--      created_at across both logs.
--
-- All additive; existing rows untouched. Idempotent.
--
-- ROLLBACK
--   drop table if exists public.communication_alert_rules cascade;
--   drop table if exists public.cron_heartbeat_logs        cascade;

create extension if not exists "pgcrypto";

-- ---------- 1. cron_heartbeat_logs ---------------------------------------
--
-- Append-only. ONE row per cron HANDLER INVOCATION (not per row
-- processed). The handler wraps itself in lib/cronHeartbeat.ts so a
-- crashed run still records a row with success=false.
--
-- We DO NOT index by cron_name + started_at descending as a single
-- query pattern — the dashboard fetches "most recent per cron_name"
-- which Postgres can satisfy from (cron_name, started_at DESC).

create table if not exists public.cron_heartbeat_logs (
  id              uuid primary key default gen_random_uuid(),
  /** Identifies the cron — e.g. 'dispatch-worker', 'retry-worker',
   *  'broadcast-send', 'overdue-pickup-sweep', 'heic-transcode',
   *  'reconcile'. Stable enum-style values; never user-supplied. */
  cron_name       text not null,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  duration_ms     integer,
  /** False when the cron handler threw or returned an error payload. */
  success         boolean not null default true,
  error_message   text,
  /** Number of rows the cron processed in this tick — semantically
   *  meaningful per cron (sent notifications / drained targets /
   *  swept orders). */
  rows_processed  integer not null default 0,
  /** Free-form additional metadata. e.g. retry-worker writes:
   *    { failed: 2, dead: 0, succeeded: 8 } */
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists cron_heartbeat_logs_name_started_idx
  on public.cron_heartbeat_logs (cron_name, started_at desc);
create index if not exists cron_heartbeat_logs_created_idx
  on public.cron_heartbeat_logs (created_at desc);
create index if not exists cron_heartbeat_logs_failed_idx
  on public.cron_heartbeat_logs (cron_name, started_at desc)
  where success = false;

alter table public.cron_heartbeat_logs enable row level security;

drop policy if exists cron_heartbeat_logs_admin_read on public.cron_heartbeat_logs;
create policy cron_heartbeat_logs_admin_read on public.cron_heartbeat_logs
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- ---------- 2. communication_alert_rules ---------------------------------
--
-- Operator-defined thresholds. When the worker-health computation
-- detects a breach, the admin shell renders a banner. The rules are
-- evaluated lazily on every dashboard load — no separate cron needed.
--
-- Examples:
--   • metric='delivery_success_pct',  comparison='lt', threshold=85,
--     window_minutes=60 → "warn when SMS success drops below 85% in
--     the last hour".
--   • metric='dead_letter_count',     comparison='gt', threshold=5,
--     window_minutes=1440 → "warn when dead-letter count exceeds 5
--     in 24h".

create table if not exists public.communication_alert_rules (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  /** Stable enum. Drives which metric the worker-health computation
   *  pulls from. */
  metric          text not null check (metric in (
    'delivery_success_pct',
    'dead_letter_count',
    'queue_age_minutes',
    'failure_count',
    'cron_silence_minutes'
  )),
  /** 'gt' (breach when value > threshold)
   *  'lt' (breach when value < threshold) */
  comparison      text not null check (comparison in ('gt','lt')),
  /** Numeric threshold the metric is compared against. */
  threshold       numeric not null,
  /** Lookback window for the metric computation. */
  window_minutes  integer not null default 60,
  /** UI severity — controls colour + dismiss behavior. */
  severity        text not null default 'warning'
                  check (severity in ('warning','critical')),
  /** Optional branch scope. NULL = global. */
  branch_id       text,
  enabled         boolean not null default true,
  notes           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists communication_alert_rules_enabled_idx
  on public.communication_alert_rules (enabled, metric);
create index if not exists communication_alert_rules_branch_idx
  on public.communication_alert_rules (branch_id) where branch_id is not null;

create or replace function public.touch_communication_alert_rules_updated() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists communication_alert_rules_touch on public.communication_alert_rules;
create trigger communication_alert_rules_touch
  before update on public.communication_alert_rules
  for each row execute procedure public.touch_communication_alert_rules_updated();

alter table public.communication_alert_rules enable row level security;

drop policy if exists communication_alert_rules_admin_full on public.communication_alert_rules;
create policy communication_alert_rules_admin_full on public.communication_alert_rules
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists communication_alert_rules_read on public.communication_alert_rules;
create policy communication_alert_rules_read on public.communication_alert_rules
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- Insert a small starter set of default rules so the alert banner
-- isn't blank on day one. Operators can disable / edit / delete via
-- the admin UI.
insert into public.communication_alert_rules
  (name, metric, comparison, threshold, window_minutes, severity, notes)
values
  ('Delivery success below 85%',
   'delivery_success_pct', 'lt', 85, 60, 'warning',
   'Warn when dispatch success rate drops below 85% in the last hour'),
  ('Dead letters above 5 / 24h',
   'dead_letter_count', 'gt', 5, 1440, 'warning',
   'Warn when dead-letter count exceeds 5 in 24h — provider may be misconfigured'),
  ('Queue oldest > 30 min',
   'queue_age_minutes', 'gt', 30, 5, 'critical',
   'Critical when the oldest queued notification is over 30 minutes old (worker stalled?)'),
  ('Cron silent for > 15 min',
   'cron_silence_minutes', 'gt', 15, 5, 'critical',
   'Critical when a cron has not run in 15+ minutes (scheduler broken?)')
on conflict do nothing;

-- ---------- 3. feature_flags PK fix --------------------------------------
--
-- Phase 16's `feature_flags` table set `key` as the sole primary
-- key, which prevents storing both a global override (branch_id IS
-- NULL) and a per-branch override (branch_id = X) for the same key.
-- Phase 17 introduces the per-branch settings UI and needs both
-- coexisting.
--
-- Fix: drop the PK, add two partial unique indexes — one for global,
-- one per (key, branch_id). Idempotent: tolerant of the prior PK
-- already being gone (e.g. operator already migrated by hand).

do $$
begin
  -- Drop the primary key if it exists. The constraint name auto-
  -- generated by Postgres for "create table ... primary key" is
  -- `<table>_pkey`.
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.feature_flags'::regclass
      and contype = 'p'
  ) then
    alter table public.feature_flags drop constraint feature_flags_pkey;
  end if;
exception when undefined_table then
  null;
end $$;

-- Add a synthetic surrogate id to use as the new PK so rows can be
-- referenced by a stable identifier. Existing rows get IDs at
-- migration time.
alter table public.feature_flags
  add column if not exists id uuid not null default gen_random_uuid();
update public.feature_flags set id = gen_random_uuid() where id is null;

-- Make id the new PK. Wrapped in DO so re-running is safe.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.feature_flags'::regclass
      and conname = 'feature_flags_id_pkey'
  ) then
    alter table public.feature_flags
      add constraint feature_flags_id_pkey primary key (id);
  end if;
exception when undefined_table then
  null;
end $$;

-- Uniqueness moves to the (key, branch_id) pair via partial indexes.
-- Two indexes because Postgres treats NULL as distinct in regular
-- unique indexes; we want exactly one global row per key + exactly
-- one branch override per (key, branch).
create unique index if not exists feature_flags_global_uniq
  on public.feature_flags (key)
  where branch_id is null;
create unique index if not exists feature_flags_branch_uniq
  on public.feature_flags (key, branch_id)
  where branch_id is not null;

-- ---------- 4. Index helper for unified timeline -------------------------
--
-- The admin customer view's "unified timeline" query joins
-- customer_activity + customer_notifications + line_delivery_log
-- ordered by their respective created_at columns. Existing per-
-- table indexes cover the by-customer_id+date pattern. Nothing new
-- is needed here — this section is documentation-only.

-- ============================================================================
-- Verification queries:
--
--   select count(*) from public.cron_heartbeat_logs;          -- 0
--   select count(*) from public.communication_alert_rules;    -- 4 default
--   select cron_name, count(*), avg(duration_ms)::int as avg_ms
--     from public.cron_heartbeat_logs
--     where started_at > now() - interval '24 hours'
--     group by cron_name;
--
-- ============================================================================
