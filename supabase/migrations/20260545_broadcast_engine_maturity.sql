-- Phase 21 — Broadcast engine maturity cleanup.
--
-- Six concrete schema changes:
--
--   1. broadcast_drafts.status — allow 'paused'. Operators can pause a
--      draft so any queued send_job for it stops accepting new ticks,
--      and the UI hides the "Send live" action.
--
--   2. broadcast_send_jobs.broadcast_draft_id — already present via
--      draft_id. NO change needed — this comment exists so future
--      readers don't look for a missing column.
--
--   3. public.worker_locks — distributed advisory lock table. Each
--      cron acquires a row by name + nonce; the row's expires_at gates
--      concurrent ticks. We use a row (rather than pg_advisory_xact_lock)
--      so it works across pooled Supabase connections without relying
--      on session affinity.
--
--   4. public.cron_failure_streaks — derived counter computed by the
--      cronHeartbeat wrapper after every tick. Persisted (not just
--      a view) so the workers page reads O(1).
--
--   5. broadcast_audit_log.action — extend the CHECK to include
--      'pause', 'resume', 'send_queued', 'send_started', 'send_completed',
--      'send_cancelled', 'send_paused', 'send_resumed'. These actions
--      were already being inserted by the API; the CHECK now matches.
--
--   6. broadcast_audit_log composite index on (draft_id, created_at desc)
--      for the audit-log view rendered next to draft details.
--
-- All additions are forward-compat: existing rows keep their values
-- (status='draft' is unchanged), no data backfill needed.

begin;

-- ---------- 1. broadcast_drafts.status accepts 'paused' -----------------

alter table public.broadcast_drafts
  drop constraint if exists broadcast_drafts_status_check;

alter table public.broadcast_drafts
  add constraint broadcast_drafts_status_check
  check (status in ('draft','preview','paused','archived'));

-- ---------- 2. worker_locks ---------------------------------------------
--
-- One row per logical cron. The cronHeartbeat wrapper:
--   • DELETEs any row whose expires_at < now() (stale lock).
--   • INSERTs (lock_name, nonce, expires_at) — on unique violation,
--     the tick treats the lock as held and skips.
--   • At the end of the tick, deletes the row by (lock_name, nonce).
--
-- Why not pg_try_advisory_xact_lock? PostgREST / Supabase don't
-- expose it cleanly + advisory locks are session-scoped, which makes
-- ownership tracking awkward across pooled connections. A row works
-- everywhere and is auditable.

create table if not exists public.worker_locks (
  lock_name     text primary key,
  nonce         uuid not null,
  acquired_at   timestamptz not null default now(),
  expires_at    timestamptz not null,
  acquired_by   text
);

create index if not exists worker_locks_expires_idx
  on public.worker_locks (expires_at);

alter table public.worker_locks enable row level security;

drop policy if exists worker_locks_admin_read on public.worker_locks;
create policy worker_locks_admin_read on public.worker_locks
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- ---------- 3. cron_failure_streaks -------------------------------------
--
-- One row per cron_name. The cronHeartbeat wrapper:
--   • On success: upserts streak=0, last_success_at=now().
--   • On failure: upserts streak=streak+1, last_failure_at=now(),
--                 last_failure_message=err.
--
-- The workers page reads this directly to surface "× 3 consecutive
-- failures" without scanning cron_heartbeat_logs every render.

create table if not exists public.cron_failure_streaks (
  cron_name              text primary key,
  current_streak         integer not null default 0,
  last_success_at        timestamptz,
  last_failure_at        timestamptz,
  last_failure_message   text,
  updated_at             timestamptz not null default now()
);

alter table public.cron_failure_streaks enable row level security;

drop policy if exists cron_failure_streaks_admin_read on public.cron_failure_streaks;
create policy cron_failure_streaks_admin_read on public.cron_failure_streaks
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- ---------- 4. broadcast_audit_log: expanded action vocabulary -----------

alter table public.broadcast_audit_log
  drop constraint if exists broadcast_audit_log_action_check;

alter table public.broadcast_audit_log
  add constraint broadcast_audit_log_action_check
  check (action in (
    'create','update','archive','restore','estimate',
    'pause','resume',
    'send_queued','send_started','send_completed',
    'send_cancelled','send_paused','send_resumed'
  ));

create index if not exists broadcast_audit_log_draft_recent_idx
  on public.broadcast_audit_log (draft_id, created_at desc)
  where draft_id is not null;

-- ---------- 5. broadcast_send_targets: active-job dedup index -----------
--
-- Used by the cross-draft dedup pre-flight at send-create time:
-- "any pending/dispatched target for this customer in the last N days?"
-- The partial index keeps it small — only rows that count for dedup.

create index if not exists broadcast_send_targets_active_dedup_idx
  on public.broadcast_send_targets (customer_id, created_at desc)
  where status in ('pending','dispatched');

commit;
