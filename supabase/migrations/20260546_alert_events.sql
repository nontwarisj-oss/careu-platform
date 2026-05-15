-- Phase 22 — Cap enforcement + alert routing + link wrap + lock janitor.
--
-- One concrete schema change: public.alert_events.
--
-- Phase 17 shipped communication_alert_rules — operator-defined
-- thresholds — but the evaluator (lib/workerHealth.ts) only computed
-- breaches in-memory on every dashboard load. Nothing PERSISTED a
-- fired alert, so:
--   • an alert that fired + cleared between two dashboard visits was
--     never seen;
--   • there was no acknowledge / resolve workflow;
--   • there was no record to route to email / LINE / Slack.
--
-- alert_events fixes that. The Phase 22 worker-maintenance cron
-- evaluates the rules every tick and UPSERTs an event row per active
-- breach. The row carries an acknowledge/resolve lifecycle so the
-- operator can work an incident to closure.
--
-- Dedup model: at most ONE 'active'/'acknowledged' row per
-- (rule_id, branch_id, metric). A repeat breach bumps last_seen_at +
-- occurrence_count instead of inserting. When the rule stops
-- breaching, the maintenance sweep flips the row to 'resolved'
-- (auto-resolve).
--
-- All additive. Idempotent.
--
-- ROLLBACK
--   drop table if exists public.alert_events cascade;

begin;

create table if not exists public.alert_events (
  id                 uuid primary key default gen_random_uuid(),
  /** The rule that fired. SET NULL on rule delete — the event stays
   *  for the audit trail even if the operator removes the rule. */
  rule_id            uuid references public.communication_alert_rules(id) on delete set null,
  /** Denormalised rule name — survives rule deletion. */
  rule_name          text not null,
  /** What was measured. Mirrors communication_alert_rules.metric. */
  metric             text not null,
  severity           text not null default 'warning'
                     check (severity in ('warning','critical')),
  /** Which worker / surface produced the breach. */
  source             text not null default 'worker-maintenance'
                     check (source in (
                       'worker-maintenance','cron-heartbeat','dispatch-worker',
                       'broadcast-worker','dead-letter-monitor','manual'
                     )),
  branch_id          text,
  /** Observed value vs the rule's threshold at fire time. */
  observed           numeric,
  threshold          numeric,
  comparison         text check (comparison in ('gt','lt')),
  /** Lifecycle. active → acknowledged → resolved. The maintenance
   *  sweep auto-resolves when the rule no longer breaches; an
   *  operator may also resolve manually. */
  status             text not null default 'active'
                     check (status in ('active','acknowledged','resolved')),
  detail             jsonb not null default '{}'::jsonb,
  /** Counters for a recurring breach. */
  occurrence_count   integer not null default 1,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  acknowledged_at    timestamptz,
  acknowledged_by    uuid,
  resolved_at        timestamptz,
  resolved_by        uuid,
  /** 'auto' when the maintenance sweep resolved it; 'operator' when
   *  a human did. */
  resolved_via       text check (resolved_via in ('auto','operator')),
  created_at         timestamptz not null default now()
);

create index if not exists alert_events_status_idx
  on public.alert_events (status, last_seen_at desc);
create index if not exists alert_events_branch_idx
  on public.alert_events (branch_id) where branch_id is not null;
create index if not exists alert_events_rule_idx
  on public.alert_events (rule_id, last_seen_at desc);

-- At most one open (active OR acknowledged) event per logical alert.
-- A NULL branch_id is treated as its own bucket via coalesce.
create unique index if not exists alert_events_open_unique
  on public.alert_events (rule_id, coalesce(branch_id, ''), metric)
  where status in ('active','acknowledged');

alter table public.alert_events enable row level security;

drop policy if exists alert_events_admin_read on public.alert_events;
create policy alert_events_admin_read on public.alert_events
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists alert_events_branch_read on public.alert_events;
create policy alert_events_branch_read on public.alert_events
  for select to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

commit;
