-- Broadcast send pipeline + scheduling + feature flags.
--
-- The Phase 15 broadcast tables are draft-only. This migration adds
-- the SEND side: jobs that fan a draft out to per-customer queue rows,
-- per-target dispatch records, attempt logs for fan-out passes, daily
-- aggregated metrics, and a feature-flag table that gates risky
-- behavior (mass-send, cross-branch, scheduled).
--
-- Single-branch-by-default is enforced via:
--   1. RLS on broadcast_send_jobs (branch_manager scoped to own branch).
--   2. feature_flags row 'enable_cross_branch_broadcasts' defaulting
--      to false — checked in the send API before allowing a job whose
--      audience spans branches.
--
-- ROLLBACK
--   drop table if exists public.broadcast_metrics_daily   cascade;
--   drop table if exists public.broadcast_send_attempts   cascade;
--   drop table if exists public.broadcast_send_targets    cascade;
--   drop table if exists public.broadcast_send_jobs       cascade;
--   drop table if exists public.feature_flags             cascade;

create extension if not exists "pgcrypto";

-- ---------- 1. feature_flags ---------------------------------------------
--
-- Server-side feature flags. Key/value/optional branch scope. Reads
-- via lib/featureFlags.ts. Single source of truth for "is the
-- mass-send button enabled" / "can we send to multiple branches in
-- one job" / "is the cron scheduler armed".
--
-- Defaults (inserted at end of this migration):
--   enable_sms                       = true
--   enable_line_broadcast            = true
--   enable_scheduled_broadcasts      = true
--   enable_cross_branch_broadcasts   = false
--   broadcast_max_targets_per_job    = 2000
--   broadcast_quiet_hours_start_h    = 9
--   broadcast_quiet_hours_end_h      = 19
--   broadcast_dedup_window_hours     = 24

create table if not exists public.feature_flags (
  key            text primary key,
  value          jsonb not null,
  notes          text,
  /** Optional branch scope. NULL = global. Set to a branch slug to
   *  override the global value for that branch only. */
  branch_id      text,
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);

create index if not exists feature_flags_branch_idx
  on public.feature_flags (branch_id) where branch_id is not null;

alter table public.feature_flags enable row level security;

drop policy if exists feature_flags_admin_full on public.feature_flags;
create policy feature_flags_admin_full on public.feature_flags
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists feature_flags_read on public.feature_flags;
create policy feature_flags_read on public.feature_flags
  for select to authenticated
  using (true);

-- Default flag values. Idempotent — `on conflict do nothing` so a
-- re-run doesn't overwrite operator edits.
insert into public.feature_flags (key, value, notes) values
  ('enable_sms',                       'true'::jsonb, 'SMS broadcast channel master switch'),
  ('enable_line_broadcast',            'true'::jsonb, 'LINE broadcast channel master switch'),
  ('enable_scheduled_broadcasts',      'true'::jsonb, 'Allow scheduled (future-dated) broadcasts'),
  ('enable_cross_branch_broadcasts',   'false'::jsonb, 'When false, send_jobs whose audience spans branches are refused'),
  ('broadcast_max_targets_per_job',    '2000'::jsonb,  'Hard cap on number of targets a single send_job may fan out to'),
  ('broadcast_quiet_hours_start_h',    '9'::jsonb,     'Hour-of-day in Bangkok timezone when broadcasts may begin'),
  ('broadcast_quiet_hours_end_h',      '19'::jsonb,    'Hour-of-day in Bangkok timezone when broadcasts must stop'),
  ('broadcast_dedup_window_hours',     '24'::jsonb,    'Skip targets who received any other broadcast within N hours')
on conflict (key) do nothing;

-- ---------- 2. broadcast_send_jobs ---------------------------------------
--
-- One row per "send this draft" action. The send fan-out worker
-- creates targets from this job, then drains them in chunks. Jobs
-- transition through:
--   queued → processing → completed
--                       → paused (operator)
--                       → cancelled (operator)
--                       → failed (terminal — e.g. flag disabled mid-flight)

create table if not exists public.broadcast_send_jobs (
  id                        uuid primary key default gen_random_uuid(),
  draft_id                  uuid not null references public.broadcast_drafts(id) on delete restrict,
  /** Frozen segment definition at send time — protects against the
   *  operator editing the draft after queuing the send. */
  segment_snapshot          jsonb not null default '{}'::jsonb,
  /** Frozen template bodies at send time. */
  template_sms_snapshot     text,
  template_line_snapshot    text,
  channels                  text[] not null default '{}',
  /** Branch the job belongs to. Owner / hq_admin may set branch_id =
   *  null to mean "multi-branch" — gated by the
   *  enable_cross_branch_broadcasts feature flag. */
  branch_id                 text,
  /** When the operator wants the send to start. NULL = now. */
  scheduled_for             timestamptz,
  /** When the worker actually began fan-out. NULL until first tick. */
  started_at                timestamptz,
  completed_at              timestamptz,
  paused_at                 timestamptz,
  cancelled_at              timestamptz,
  /** Mode: 'live' actually enqueues notifications; 'dry_run' fans out
   *  targets + marks them dispatched without writing to
   *  customer_notifications. Useful for previewing the dedup outcome
   *  without spending provider quota. */
  mode                      text not null default 'live'
                            check (mode in ('live','dry_run')),
  status                    text not null default 'queued'
                            check (status in (
                              'queued','processing','paused',
                              'completed','cancelled','failed'
                            )),
  /** Expected total targets at fan-out time. Set on first
   *  fan-out tick after target rows are created. */
  expected_total            integer,
  /** Failure reason — populated when status='failed'. */
  failure_reason            text,
  created_by                uuid,
  cancelled_by              uuid,
  paused_by                 uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists broadcast_send_jobs_status_idx
  on public.broadcast_send_jobs (status, scheduled_for);
create index if not exists broadcast_send_jobs_draft_idx
  on public.broadcast_send_jobs (draft_id, created_at desc);
create index if not exists broadcast_send_jobs_branch_idx
  on public.broadcast_send_jobs (branch_id) where branch_id is not null;
create index if not exists broadcast_send_jobs_active_idx
  on public.broadcast_send_jobs (scheduled_for)
  where status in ('queued','processing');

create or replace function public.touch_broadcast_send_jobs_updated() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists broadcast_send_jobs_touch on public.broadcast_send_jobs;
create trigger broadcast_send_jobs_touch
  before update on public.broadcast_send_jobs
  for each row execute procedure public.touch_broadcast_send_jobs_updated();

alter table public.broadcast_send_jobs enable row level security;

drop policy if exists broadcast_send_jobs_admin_full on public.broadcast_send_jobs;
create policy broadcast_send_jobs_admin_full on public.broadcast_send_jobs
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists broadcast_send_jobs_branch_rw on public.broadcast_send_jobs;
create policy broadcast_send_jobs_branch_rw on public.broadcast_send_jobs
  for all to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and (branch_id is null or branch_id = public.current_user_branch_code())
  )
  with check (
    public.current_user_role() = 'branch_manager'
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 3. broadcast_send_targets ------------------------------------
--
-- One row per (job, customer, channel). Created by the fan-out worker
-- on the first pass through a job. Each target eventually:
--   • dispatches  — creates a customer_notifications row and marks
--     the target as 'dispatched' with the notification_id.
--   • skips       — preference / dedup / rate-limit rejected. Reason
--     stored in skip_reason.
--   • dead_letters — repeated dispatch failure (very rare; the
--     underlying queue's dead_letter handles this layer).
--
-- Composite unique index prevents accidentally creating two targets
-- for the same (job, customer, channel) — important when the cron
-- restarts mid fan-out.

create table if not exists public.broadcast_send_targets (
  id                  uuid primary key default gen_random_uuid(),
  send_job_id         uuid not null references public.broadcast_send_jobs(id) on delete cascade,
  customer_id         uuid not null references public.customers(id) on delete cascade,
  channel             text not null check (channel in ('sms','line','email')),
  status              text not null default 'pending'
                      check (status in ('pending','dispatched','skipped','dead_letter')),
  /** notification_id set when status=dispatched — links to the
   *  customer_notifications row the dispatch worker will deliver. */
  notification_id     uuid references public.customer_notifications(id) on delete set null,
  /** Reason when status='skipped' — preference / dedup / rate-limit. */
  skip_reason         text,
  /** When status was last set. Tracks "we processed this target". */
  processed_at        timestamptz,
  created_at          timestamptz not null default now()
);

create unique index if not exists broadcast_send_targets_unique
  on public.broadcast_send_targets (send_job_id, customer_id, channel);
create index if not exists broadcast_send_targets_pending_idx
  on public.broadcast_send_targets (send_job_id, status)
  where status = 'pending';
create index if not exists broadcast_send_targets_status_idx
  on public.broadcast_send_targets (send_job_id, status);
create index if not exists broadcast_send_targets_customer_idx
  on public.broadcast_send_targets (customer_id, created_at desc);

alter table public.broadcast_send_targets enable row level security;

-- Targets inherit the visibility of their parent job — no need for
-- a separate per-row policy beyond reading via the API.
drop policy if exists broadcast_send_targets_admin_read on public.broadcast_send_targets;
create policy broadcast_send_targets_admin_read on public.broadcast_send_targets
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists broadcast_send_targets_branch_read on public.broadcast_send_targets;
create policy broadcast_send_targets_branch_read on public.broadcast_send_targets
  for select to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and exists (
      select 1 from public.broadcast_send_jobs j
      where j.id = broadcast_send_targets.send_job_id
        and (j.branch_id is null or j.branch_id = public.current_user_branch_code())
    )
  );

-- ---------- 4. broadcast_send_attempts -----------------------------------
--
-- Append-only log of fan-out attempts. ONE row per CRON TICK that
-- processed the job. Useful for "the cron timed out at 3500/5000 —
-- which targets were processed?". Distinct from
-- notification_dispatch_log (which logs SEND attempts).

create table if not exists public.broadcast_send_attempts (
  id                uuid primary key default gen_random_uuid(),
  send_job_id       uuid not null references public.broadcast_send_jobs(id) on delete cascade,
  /** Targets attempted in this tick (across all statuses). */
  targets_processed integer not null default 0,
  /** Breakdown for the tick. */
  dispatched_count  integer not null default 0,
  skipped_count     integer not null default 0,
  failed_count      integer not null default 0,
  /** Reason when the tick decided not to run (quiet hours,
   *  flag disabled, etc.). */
  blocked_reason    text,
  duration_ms       integer,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz
);

create index if not exists broadcast_send_attempts_job_idx
  on public.broadcast_send_attempts (send_job_id, started_at desc);

alter table public.broadcast_send_attempts enable row level security;

drop policy if exists broadcast_send_attempts_admin_read on public.broadcast_send_attempts;
create policy broadcast_send_attempts_admin_read on public.broadcast_send_attempts
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists broadcast_send_attempts_branch_read on public.broadcast_send_attempts;
create policy broadcast_send_attempts_branch_read on public.broadcast_send_attempts
  for select to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and exists (
      select 1 from public.broadcast_send_jobs j
      where j.id = broadcast_send_attempts.send_job_id
        and (j.branch_id is null or j.branch_id = public.current_user_branch_code())
    )
  );

-- ---------- 5. broadcast_metrics_daily -----------------------------------
--
-- Per (job, channel, date) aggregated metrics. Updated whenever the
-- send worker processes targets. The values are derived counts — the
-- source of truth remains broadcast_send_targets + customer_notifications.
-- We materialize them here so dashboard reads are O(1) instead of
-- O(targets).

create table if not exists public.broadcast_metrics_daily (
  send_job_id       uuid not null references public.broadcast_send_jobs(id) on delete cascade,
  metric_date       date not null,
  channel           text not null,
  /** Counts. */
  queued_count      integer not null default 0,
  sent_count        integer not null default 0,
  delivered_count   integer not null default 0,
  failed_count      integer not null default 0,
  skipped_count     integer not null default 0,
  opted_out_count   integer not null default 0,
  deduped_count     integer not null default 0,
  updated_at        timestamptz not null default now(),
  primary key (send_job_id, metric_date, channel)
);

create index if not exists broadcast_metrics_daily_date_idx
  on public.broadcast_metrics_daily (metric_date desc, channel);

alter table public.broadcast_metrics_daily enable row level security;

drop policy if exists broadcast_metrics_daily_admin_read on public.broadcast_metrics_daily;
create policy broadcast_metrics_daily_admin_read on public.broadcast_metrics_daily
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists broadcast_metrics_daily_branch_read on public.broadcast_metrics_daily;
create policy broadcast_metrics_daily_branch_read on public.broadcast_metrics_daily
  for select to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and exists (
      select 1 from public.broadcast_send_jobs j
      where j.id = broadcast_metrics_daily.send_job_id
        and (j.branch_id is null or j.branch_id = public.current_user_branch_code())
    )
  );

-- ---------- 6. broadcast_audit_log additions ------------------------------
--
-- Phase 15 created broadcast_audit_log with a narrow action enum.
-- Add the send-related actions. Idempotent DROP + ADD.

do $$
begin
  alter table public.broadcast_audit_log
    drop constraint if exists broadcast_audit_log_action_check;
  alter table public.broadcast_audit_log
    add constraint broadcast_audit_log_action_check
    check (action in (
      'create','update','archive','restore','estimate',
      'send_queued','send_started','send_paused','send_resumed',
      'send_cancelled','send_completed','send_failed'
    ))
    not valid;
exception when undefined_table then
  null;
end $$;

-- ============================================================================
-- Verification queries:
--
--   select key, value, branch_id from public.feature_flags order by key;
--   select count(*) from public.broadcast_send_jobs;      -- 0
--   select count(*) from public.broadcast_send_targets;   -- 0
--   select count(*) from public.broadcast_send_attempts;  -- 0
--   select count(*) from public.broadcast_metrics_daily;  -- 0
--
-- ============================================================================
