-- Phase 19 — Per-branch trigger overrides + DOB capture + response
-- tracking + campaign attribution + performance aggregator.
--
-- Six concrete schema changes:
--
--   1. public.branch_trigger_overrides — per-branch overrides for
--      retention / lifecycle / quiet-hours thresholds. Falls back to
--      HQ defaults when no row exists.
--
--   2. public.customers DOB columns — optional birth_date + month-
--      verified flag. Customer-provided via portal; never required.
--
--   3. public.communication_events — append-only stream of provider
--      callbacks (delivered / opened / clicked / bounced /
--      unsubscribed / complained). Sibling of
--      notification_dispatch_log: that one tracks attempts; this one
--      tracks customer-side engagement.
--
--   4. public.customer_branch_unsubscribes — per (customer, branch,
--      channel) opt-out rows. Layered on top of the Phase 13 global
--      preferences table. Branch row wins when present.
--
--   5. public.campaign_response_metrics — links a campaign send to a
--      subsequent order. Attribution window = 14 days.
--
--   6. public.communication_performance_daily — per (branch, channel,
--      date) aggregated success / latency / open / click counters.
--
-- ROLLBACK
--   drop table if exists public.communication_performance_daily   cascade;
--   drop table if exists public.campaign_response_metrics         cascade;
--   drop table if exists public.customer_branch_unsubscribes      cascade;
--   drop table if exists public.communication_events              cascade;
--   alter table public.customers drop column if exists birth_date;
--   alter table public.customers drop column if exists birth_month_verified;
--   drop table if exists public.branch_trigger_overrides          cascade;

create extension if not exists "pgcrypto";

-- ---------- 1. branch_trigger_overrides ----------------------------------
--
-- One row per (branch_id, key). The trigger engine + lifecycle
-- classifier read via lib/branchTriggerOverrides.ts which falls
-- back to hard-coded HQ defaults when a key isn't set for the
-- branch.

create table if not exists public.branch_trigger_overrides (
  id           uuid primary key default gen_random_uuid(),
  branch_id    text not null,
  /** Stable keys:
   *  • dormant_days
   *  • at_risk_days
   *  • overdue_pickup_delay_days
   *  • retention_cooldown_days
   *  • vip_reactivation_delay_days
   *  • max_daily_trigger_sends
   *  • quiet_hours_start_h
   *  • quiet_hours_end_h
   *  • quiet_hours_enforced (boolean) */
  key          text not null,
  value        jsonb not null,
  notes        text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid
);

create unique index if not exists branch_trigger_overrides_unique
  on public.branch_trigger_overrides (branch_id, key);
create index if not exists branch_trigger_overrides_branch_idx
  on public.branch_trigger_overrides (branch_id);

create or replace function public.touch_branch_trigger_overrides() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists branch_trigger_overrides_touch on public.branch_trigger_overrides;
create trigger branch_trigger_overrides_touch
  before update on public.branch_trigger_overrides
  for each row execute procedure public.touch_branch_trigger_overrides();

alter table public.branch_trigger_overrides enable row level security;

drop policy if exists branch_trigger_overrides_admin_full
  on public.branch_trigger_overrides;
create policy branch_trigger_overrides_admin_full
  on public.branch_trigger_overrides
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists branch_trigger_overrides_branch_rw
  on public.branch_trigger_overrides;
create policy branch_trigger_overrides_branch_rw
  on public.branch_trigger_overrides
  for all to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and branch_id = public.current_user_branch_code()
  )
  with check (
    public.current_user_role() = 'branch_manager'
    and branch_id = public.current_user_branch_code()
  );

-- ---------- 2. customers DOB columns -------------------------------------
--
-- Birthday-month trigger from Phase 18 was wired but inert because
-- customers had no DOB. Phase 19 adds:
--   • birth_date            — full date (YYYY-MM-DD). Nullable; not
--                              required by any flow.
--   • birth_month_verified  — customer confirmed via portal flow.
--                              Used to gate the trigger so unverified
--                              guesses (e.g. operator entered a wrong
--                              year) don't spam birthday messages.

alter table public.customers
  add column if not exists birth_date date,
  add column if not exists birth_month_verified boolean not null default false;

-- Index supports "give me everyone whose birthday is THIS month" —
-- the trigger engine's hot query. Uses date_part for portability.
create index if not exists customers_birth_month_idx
  on public.customers (date_part('month'::text, birth_date))
  where birth_date is not null and birth_month_verified = true;

-- ---------- 3. communication_events --------------------------------------
--
-- Append-only stream of provider-side and customer-side events for
-- a notification. Tracks the "did the customer engage?" layer that
-- sits beyond delivery. Sources:
--
--   • Twilio status webhook  → 'delivered' / 'failed' / 'undelivered'
--   • Resend status webhook  → 'delivered' / 'opened' / 'clicked' /
--                              'bounced' / 'complained' /
--                              'unsubscribed'
--   • LINE delivery events   → 'unfollowed' (via lib/lineWebhook)
--   • Our own click tracker  → 'clicked' (signed-link redirect)
--
-- Replay safety: the (provider, provider_event_id) UNIQUE index
-- means a re-delivered webhook is a no-op.

create table if not exists public.communication_events (
  id                  uuid primary key default gen_random_uuid(),
  notification_id     uuid references public.customer_notifications(id) on delete set null,
  customer_id         uuid references public.customers(id) on delete set null,
  branch_id           text,
  channel             text not null,
  /** 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained'
   *  | 'unsubscribed' | 'failed' */
  event_type          text not null check (event_type in (
    'delivered','opened','clicked','bounced',
    'complained','unsubscribed','failed'
  )),
  provider            text,
  provider_event_id   text,
  /** When the event came from a clicked tracking link, this is the
   *  target URL the customer was redirected to. */
  target_url          text,
  /** User agent + IP hash for forensics. NOT raw IP — hashed at
   *  insert time. */
  user_agent          text,
  ip_hash             text,
  details             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create unique index if not exists communication_events_provider_uniq
  on public.communication_events (provider, provider_event_id)
  where provider_event_id is not null;
create index if not exists communication_events_notification_idx
  on public.communication_events (notification_id, created_at desc);
create index if not exists communication_events_customer_idx
  on public.communication_events (customer_id, created_at desc)
  where customer_id is not null;
create index if not exists communication_events_event_idx
  on public.communication_events (event_type, created_at desc);

alter table public.communication_events enable row level security;

drop policy if exists communication_events_admin_read on public.communication_events;
create policy communication_events_admin_read on public.communication_events
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists communication_events_branch_read on public.communication_events;
create policy communication_events_branch_read on public.communication_events
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 4. customer_branch_unsubscribes ------------------------------
--
-- Layered on top of Phase 13 customer_notification_preferences:
--   • Phase 13 row = customer's GLOBAL choice ("I want SMS").
--   • Phase 19 row = customer's PER-BRANCH override
--     ("…but not from C24 Care U Saladaeng").
--
-- The communication policy service consults both: a branch
-- unsubscribe wins over the global opt-in.

create table if not exists public.customer_branch_unsubscribes (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references public.customers(id) on delete cascade,
  branch_id           text not null,
  channel             text not null check (channel in ('sms','line','email','all')),
  /** 'marketing' (promotional only) | 'all' (incl. transactional) */
  scope               text not null default 'marketing'
                      check (scope in ('marketing','all')),
  reason              text,
  unsubscribed_at     timestamptz not null default now(),
  unsubscribed_by     text,
  /** 'self' | 'operator' | 'webhook' — provenance for the audit. */
  source              text not null default 'self'
                      check (source in ('self','operator','webhook'))
);

create unique index if not exists customer_branch_unsubscribes_unique
  on public.customer_branch_unsubscribes (customer_id, branch_id, channel, scope);
create index if not exists customer_branch_unsubscribes_customer_idx
  on public.customer_branch_unsubscribes (customer_id);
create index if not exists customer_branch_unsubscribes_branch_idx
  on public.customer_branch_unsubscribes (branch_id, channel);

alter table public.customer_branch_unsubscribes enable row level security;

drop policy if exists customer_branch_unsubscribes_admin_read
  on public.customer_branch_unsubscribes;
create policy customer_branch_unsubscribes_admin_read
  on public.customer_branch_unsubscribes
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists customer_branch_unsubscribes_branch_read
  on public.customer_branch_unsubscribes;
create policy customer_branch_unsubscribes_branch_read
  on public.customer_branch_unsubscribes
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and branch_id = public.current_user_branch_code()
  );

-- ---------- 5. campaign_response_metrics ---------------------------------
--
-- Links a customer who received a campaign (broadcast send_job /
-- retention trigger) to a subsequent order placed within the
-- attribution window. ONE row per (campaign source, customer) — the
-- first qualifying order wins.
--
-- Sources captured:
--   • 'broadcast_send_job' — points at broadcast_send_jobs.id.
--   • 'retention_trigger'  — points at retention_trigger_jobs.id.

create table if not exists public.campaign_response_metrics (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references public.customers(id) on delete cascade,
  /** Source kind + id. Stored as text+uuid so future kinds (e.g.
   *  referral campaigns) don't need a schema change. */
  source_kind         text not null check (source_kind in (
    'broadcast_send_job','retention_trigger'
  )),
  source_id           uuid not null,
  /** The order the customer placed after receiving the campaign. */
  order_id            uuid references public.orders(id) on delete set null,
  /** When the campaign send went out. */
  sent_at             timestamptz not null,
  /** When the customer placed the order. */
  responded_at        timestamptz not null,
  /** Days between send and response — used to bucket "fast respond
   *  vs late respond" in the dashboard. */
  response_days       integer not null default 0,
  /** Order value at attribution time. Frozen so later edits don't
   *  retroactively change ROI history. */
  order_value_thb     numeric(14,2) not null default 0,
  /** Did this attribution recover a dormant customer? Computed from
   *  customer_lifecycle_status at attribution time. */
  recovered_dormant   boolean not null default false,
  branch_id           text,
  created_at          timestamptz not null default now()
);

create unique index if not exists campaign_response_metrics_unique
  on public.campaign_response_metrics (source_kind, source_id, customer_id);
create index if not exists campaign_response_metrics_customer_idx
  on public.campaign_response_metrics (customer_id, responded_at desc);
create index if not exists campaign_response_metrics_branch_idx
  on public.campaign_response_metrics (branch_id, responded_at desc)
  where branch_id is not null;
create index if not exists campaign_response_metrics_responded_idx
  on public.campaign_response_metrics (responded_at desc);

alter table public.campaign_response_metrics enable row level security;

drop policy if exists campaign_response_metrics_admin_read
  on public.campaign_response_metrics;
create policy campaign_response_metrics_admin_read
  on public.campaign_response_metrics
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists campaign_response_metrics_branch_read
  on public.campaign_response_metrics;
create policy campaign_response_metrics_branch_read
  on public.campaign_response_metrics
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 6. communication_performance_daily ---------------------------
--
-- Per (branch, channel, date) aggregated metrics. Sibling of
-- broadcast_metrics_daily but at the channel rather than per-job
-- level. Drives the "communications performance" dashboard widget.

create table if not exists public.communication_performance_daily (
  branch_id              text,
  channel                text not null,
  metric_date            date not null,
  sent_count             integer not null default 0,
  delivered_count        integer not null default 0,
  opened_count           integer not null default 0,
  clicked_count          integer not null default 0,
  bounced_count          integer not null default 0,
  unsubscribed_count     integer not null default 0,
  failed_count           integer not null default 0,
  /** avg of latency_ms from notification_dispatch_log for the day. */
  avg_latency_ms         integer,
  updated_at             timestamptz not null default now(),
  primary key (branch_id, channel, metric_date)
);

create index if not exists communication_performance_daily_date_idx
  on public.communication_performance_daily (metric_date desc, channel);

alter table public.communication_performance_daily enable row level security;

drop policy if exists communication_performance_daily_admin_read
  on public.communication_performance_daily;
create policy communication_performance_daily_admin_read
  on public.communication_performance_daily
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists communication_performance_daily_branch_read
  on public.communication_performance_daily;
create policy communication_performance_daily_branch_read
  on public.communication_performance_daily
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ============================================================================
-- Verification queries:
--
--   select count(*) from public.branch_trigger_overrides;          -- 0
--   select count(*) from public.communication_events;              -- 0
--   select count(*) from public.customer_branch_unsubscribes;      -- 0
--   select count(*) from public.campaign_response_metrics;         -- 0
--   select count(*) from public.communication_performance_daily;   -- 0
--   select count(*) from public.customers where birth_date is not null;  -- 0
--
-- ============================================================================
