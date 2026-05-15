-- Phase 23 — Alert delivery + email routing + weekly operator digest.
--
-- Phase 22 PERSISTED alert breaches (alert_events) and SURFACED them in
-- the admin UI. It did not DELIVER them — email/LINE routing were
-- intent-logged stubs. This phase moves alerts from "visible if you
-- open the dashboard" to "delivered to the responsible operator".
--
-- Three schema changes:
--
--   1. public.alert_preferences — operator-managed routing config:
--      who gets emailed, the minimum severity worth a push, alert
--      quiet hours, per-branch recipient overrides, weekly-digest
--      opt-in. Mirrors the engagement_guardrails one-row-per-branch
--      shape (null branch_id = global default).
--
--   2. public.alert_deliveries — one row per delivery ATTEMPT, per
--      channel. Powers the admin "alert history" view: sent /
--      delivered / failed / skipped. Also records weekly-digest
--      sends (alert_event_id null, kind='digest').
--
--   3. alert_events += last_routed_at + escalation_count — drives the
--      escalation cooldown: a still-unacknowledged alert re-routes
--      once per cooldown window instead of going silent forever.
--
-- All additive. Idempotent.
--
-- ROLLBACK
--   drop table if exists public.alert_deliveries  cascade;
--   drop table if exists public.alert_preferences cascade;
--   alter table public.alert_events
--     drop column if exists last_routed_at,
--     drop column if exists escalation_count;

begin;

-- ---------- 1. alert_preferences ----------------------------------------

create table if not exists public.alert_preferences (
  id                   uuid primary key default gen_random_uuid(),
  /** null = global default; a string = per-branch override. */
  branch_id            text,
  /** Email addresses that receive routed alerts for this scope.
   *  Empty = no email routing (Slack / log still apply). */
  recipients           text[] not null default '{}',
  /** Lowest severity worth a push. 'warning' routes everything;
   *  'critical' suppresses warnings (still persisted + UI-visible). */
  min_severity         text not null default 'warning'
                       check (min_severity in ('warning','critical')),
  /** Bangkok hour-of-day window during which NON-critical alerts are
   *  held back. Critical alerts always route. NULL = no quiet hours. */
  quiet_hours_start_h  integer,
  quiet_hours_end_h    integer,
  /** Master switch for alert delivery in this scope. */
  enabled              boolean not null default true,
  /** Opt-in for the weekly operator digest email. */
  digest_enabled       boolean not null default true,
  updated_at           timestamptz not null default now(),
  updated_by           uuid
);

-- One global row, one row per branch.
create unique index if not exists alert_preferences_global_unique
  on public.alert_preferences ((true)) where branch_id is null;
create unique index if not exists alert_preferences_branch_unique
  on public.alert_preferences (branch_id) where branch_id is not null;

alter table public.alert_preferences enable row level security;

drop policy if exists alert_preferences_admin_all on public.alert_preferences;
create policy alert_preferences_admin_all on public.alert_preferences
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

-- ---------- 2. alert_deliveries -----------------------------------------

create table if not exists public.alert_deliveries (
  id              uuid primary key default gen_random_uuid(),
  /** The alert this delivery is for. NULL for weekly-digest sends
   *  (kind='digest') — those aren't tied to a single alert event. */
  alert_event_id  uuid references public.alert_events(id) on delete cascade,
  /** What kind of message this delivery carried. */
  kind            text not null default 'alert'
                  check (kind in ('alert','escalation','digest')),
  channel         text not null
                  check (channel in ('email','slack','line','console')),
  recipient       text,
  /** sent     — handed to the provider OK.
   *  delivered— provider confirmed (rare; most providers are async).
   *  failed   — provider rejected / threw.
   *  skipped  — suppressed by preferences (quiet hours / severity). */
  status          text not null
                  check (status in ('sent','delivered','failed','skipped')),
  branch_id       text,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists alert_deliveries_event_idx
  on public.alert_deliveries (alert_event_id, created_at desc);
create index if not exists alert_deliveries_recent_idx
  on public.alert_deliveries (created_at desc);
create index if not exists alert_deliveries_kind_idx
  on public.alert_deliveries (kind, created_at desc);

alter table public.alert_deliveries enable row level security;

drop policy if exists alert_deliveries_admin_read on public.alert_deliveries;
create policy alert_deliveries_admin_read on public.alert_deliveries
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists alert_deliveries_branch_read on public.alert_deliveries;
create policy alert_deliveries_branch_read on public.alert_deliveries
  for select to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 3. alert_events escalation columns --------------------------

alter table public.alert_events
  add column if not exists last_routed_at    timestamptz,
  add column if not exists escalation_count  integer not null default 0;

commit;
