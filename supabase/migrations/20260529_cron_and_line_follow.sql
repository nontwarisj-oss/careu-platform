-- Cron heartbeat + LINE follow webhook staging.
--
--   1. public.worker_runs — one row per cron / manual worker tick. Drives
--      the "last cron run" indicator on /admin/recovery so operators can
--      see at a glance whether the auto-retry loop is alive.
--   2. public.line_follow_events — append-only audit of every LINE webhook
--      event. Captures both verified and unverified attempts so admins can
--      see if someone is probing the endpoint. Verified `follow` events
--      also upsert into public.customer_line_links (with customer_id=NULL,
--      consented_at=now()) so a future admin linker UI can pair LINE users
--      with real customers without re-walking the webhook log.
--
-- Both tables are admin-read-only via RLS. Writes happen through the
-- service-role client (route handlers).
--
-- ROLLBACK
--   drop table if exists public.worker_runs;
--   drop table if exists public.line_follow_events;

create extension if not exists "pgcrypto";

-- ---------- 1. worker_runs heartbeat --------------------------------------

create table if not exists public.worker_runs (
  id           uuid primary key default gen_random_uuid(),
  /** Worker identifier — today only 'retry_tick'. Add new kinds (e.g.
      'kpi_rebuild') here when more workers join. */
  worker_kind  text not null,
  /** profiles.id of the triggering operator, or the string 'cron' when
      fired by the scheduled job. */
  actor_id     text,
  /** Optional branch scope. NULL = all branches (owner / hq_admin or cron
      without filter). */
  branch_code  text,
  started_at   timestamptz not null,
  finished_at  timestamptz not null,
  processed    integer not null default 0,
  succeeded    integer not null default 0,
  failed       integer not null default 0,
  dead         integer not null default 0,
  skipped      integer not null default 0,
  /** Full RetryTickResult.items for postmortem. JSONB so admins can grep
      `result @> '{"items":[{"kind":"line_send"}]}'` etc. */
  result       jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists worker_runs_kind_created_idx
  on public.worker_runs (worker_kind, created_at desc);
create index if not exists worker_runs_actor_idx
  on public.worker_runs (actor_id);

alter table public.worker_runs enable row level security;

drop policy if exists worker_runs_admin_read on public.worker_runs;
create policy worker_runs_admin_read on public.worker_runs
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- ---------- 2. line_follow_events staging ---------------------------------

create table if not exists public.line_follow_events (
  id                  uuid primary key default gen_random_uuid(),
  /** LINE's reported event type. We accept `follow` / `unfollow` /
      `message` (informational) and bucket anything else under `other` so
      a future webhook contract change doesn't break our writer. */
  event_type          text not null check (event_type in (
                        'follow','unfollow','message','other'
                      )),
  line_user_id        text not null,
  /** Full raw event payload. Useful when troubleshooting webhook drift. */
  raw_event           jsonb,
  /** True only when the x-line-signature header matched. Unverified
      attempts are recorded so admins can spot probe traffic. */
  signature_verified  boolean not null default false,
  received_at         timestamptz not null default now(),
  /** Set to received_at for verified `follow` events (PDPA consent
      timestamp). NULL for unfollow / unverified events. */
  consented_at        timestamptz,
  /** Set when an admin pairs this LINE user with a real customer via a
      future linker UI. Today this remains NULL. */
  linked_to_customer_id uuid references public.customers(id) on delete set null,
  linked_by           uuid,
  linked_at           timestamptz
);

create index if not exists line_follow_events_line_user_idx
  on public.line_follow_events (line_user_id, received_at desc);
create index if not exists line_follow_events_unlinked_idx
  on public.line_follow_events (received_at desc)
  where linked_to_customer_id is null;
create index if not exists line_follow_events_unverified_idx
  on public.line_follow_events (received_at desc)
  where signature_verified = false;

alter table public.line_follow_events enable row level security;

drop policy if exists line_follow_events_admin_read on public.line_follow_events;
create policy line_follow_events_admin_read on public.line_follow_events
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- No INSERT policy — the webhook route writes via service-role only.
-- No UPDATE policy either; the future admin linker will use the same
-- service-role path (admin client) to fill linked_to_customer_id.

-- ============================================================================
-- Verification queries:
--
--   select count(*) from public.worker_runs;       -- 0 until first cron tick
--   select count(*) from public.line_follow_events;-- 0 until first webhook
--   select policyname from pg_policies
--     where schemaname='public' and tablename in ('worker_runs','line_follow_events');
--
-- ============================================================================
