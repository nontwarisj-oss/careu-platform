-- Phase 20 — Operator-configurable engagement controls.
--
-- Five concrete schema changes:
--
--   1. public.campaign_funnel_metrics — per (source_kind, source_id,
--      channel, branch_id, date) funnel counts. Sibling of
--      campaign_response_metrics: that one is per-customer; this is
--      per-campaign aggregate.
--
--   2. public.engagement_guardrails — owner-managed safety caps +
--      global emergency stop. Layered above feature_flags so the
--      operator can hit a "no more campaigns today" panic button
--      without flipping individual flags.
--
--   3. public.quote_requests UTM columns — utm_source, utm_medium,
--      utm_campaign, utm_branch, utm_channel, attributed_notification_id.
--      The public quote form persists these from the URL.
--
--   4. public.orders attribution columns — attribution_source_kind,
--      attribution_source_id, attribution_channel. Set by
--      attributeOrderToCampaign so the order row carries the
--      campaign reference inline (cheaper than always joining
--      campaign_response_metrics).
--
--   5. Default rows for engagement_guardrails (HQ caps).
--
-- All additive; existing data untouched. Idempotent.
--
-- ROLLBACK
--   alter table public.orders drop column if exists attribution_source_kind;
--   alter table public.orders drop column if exists attribution_source_id;
--   alter table public.orders drop column if exists attribution_channel;
--   alter table public.quote_requests drop column if exists utm_source;
--   alter table public.quote_requests drop column if exists utm_medium;
--   alter table public.quote_requests drop column if exists utm_campaign;
--   alter table public.quote_requests drop column if exists utm_branch;
--   alter table public.quote_requests drop column if exists utm_channel;
--   alter table public.quote_requests drop column if exists attributed_notification_id;
--   drop table if exists public.engagement_guardrails cascade;
--   drop table if exists public.campaign_funnel_metrics cascade;

create extension if not exists "pgcrypto";

-- ---------- 1. campaign_funnel_metrics -----------------------------------
--
-- Per-campaign aggregated funnel. One row per (source_kind, source_id,
-- channel, branch_id, metric_date). The Phase 19 campaign_response_
-- metrics table records ONE row per customer who responded;
-- campaign_funnel_metrics tracks the broader funnel including the
-- delivered/opened/clicked steps PRIOR to a customer responding.
--
-- Sources:
--   • 'broadcast_send_job' — points at broadcast_send_jobs.id
--   • 'retention_trigger'  — points at retention_trigger_jobs.id
--
-- Updated by:
--   • Dispatch worker on send success           → delivered_count++
--   • Email/track webhooks on open/click        → opened/clicked++
--   • Quote-flow attribution (Phase 20)         → quote_started_count++
--   • Order-create attribution (Phase 20)       → order_count++ + revenue

create table if not exists public.campaign_funnel_metrics (
  source_kind             text not null check (source_kind in (
    'broadcast_send_job','retention_trigger'
  )),
  source_id               uuid not null,
  channel                 text not null,
  branch_id               text,
  metric_date             date not null,
  delivered_count         integer not null default 0,
  opened_count            integer not null default 0,
  clicked_count           integer not null default 0,
  quote_started_count     integer not null default 0,
  order_count             integer not null default 0,
  revenue_thb             numeric(14,2) not null default 0,
  updated_at              timestamptz not null default now(),
  primary key (source_kind, source_id, channel, branch_id, metric_date)
);

create index if not exists campaign_funnel_metrics_branch_idx
  on public.campaign_funnel_metrics (branch_id, metric_date desc)
  where branch_id is not null;
create index if not exists campaign_funnel_metrics_source_idx
  on public.campaign_funnel_metrics (source_kind, source_id);

alter table public.campaign_funnel_metrics enable row level security;

drop policy if exists campaign_funnel_metrics_admin_read
  on public.campaign_funnel_metrics;
create policy campaign_funnel_metrics_admin_read
  on public.campaign_funnel_metrics
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists campaign_funnel_metrics_branch_read
  on public.campaign_funnel_metrics;
create policy campaign_funnel_metrics_branch_read
  on public.campaign_funnel_metrics
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 2. engagement_guardrails -------------------------------------
--
-- Owner-managed safety layer. Three kinds of rows:
--   • Global caps   — branch_id IS NULL. Apply to every send.
--   • Per-branch    — branch_id = slug. Apply on top of global.
--   • Emergency     — key='global_emergency_stop'. When enabled,
--                     ALL dispatch ticks return immediately.
--
-- The retention engine, broadcast engine, and dispatch worker all
-- consult this table BEFORE sending. Phase 20 wires the read path;
-- per-branch UI lets owners edit.

create table if not exists public.engagement_guardrails (
  id              uuid primary key default gen_random_uuid(),
  /** Stable keys (alpha-bound for forward compat):
   *  • global_emergency_stop          (boolean) — halts all sends
   *  • max_sends_per_day_global       (integer) — across all branches
   *  • max_sends_per_day_branch       (integer) — per branch
   *  • max_campaigns_per_week_branch  (integer)
   *  • branch_escalation_threshold    (integer) — alert when crossed
   *  • dry_run_required               (boolean) — refuse send w/o prior dry-run */
  key             text not null,
  value           jsonb not null,
  branch_id       text,
  notes           text,
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);

create unique index if not exists engagement_guardrails_global_uniq
  on public.engagement_guardrails (key) where branch_id is null;
create unique index if not exists engagement_guardrails_branch_uniq
  on public.engagement_guardrails (key, branch_id) where branch_id is not null;

create or replace function public.touch_engagement_guardrails() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists engagement_guardrails_touch on public.engagement_guardrails;
create trigger engagement_guardrails_touch
  before update on public.engagement_guardrails
  for each row execute procedure public.touch_engagement_guardrails();

alter table public.engagement_guardrails enable row level security;

-- Only owner / hq_admin write. Everyone authenticated can READ — the
-- workers / dispatch consult this on every tick via the service-role
-- client; the read policy keeps in-Postgres reads honest too.
drop policy if exists engagement_guardrails_admin_full on public.engagement_guardrails;
create policy engagement_guardrails_admin_full on public.engagement_guardrails
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists engagement_guardrails_read on public.engagement_guardrails;
create policy engagement_guardrails_read on public.engagement_guardrails
  for select to authenticated using (true);

-- Default rows. Idempotent. Operators can edit / delete via UI.
insert into public.engagement_guardrails (key, value, notes) values
  ('global_emergency_stop', 'false'::jsonb,
   'Master kill switch. When true, the dispatch + retention + broadcast workers refuse to send anything.'),
  ('max_sends_per_day_global', '5000'::jsonb,
   'Aggregate cap across all branches per UTC day.'),
  ('max_sends_per_day_branch', '1000'::jsonb,
   'Default per-branch daily cap. Branch-scoped rows override.'),
  ('max_campaigns_per_week_branch', '5'::jsonb,
   'How many broadcast send_jobs per branch per ISO week before refusing.'),
  ('dry_run_required', 'false'::jsonb,
   'When true, refuses live broadcasts that have no prior successful dry_run.')
on conflict do nothing;

-- ---------- 3. quote_requests UTM columns --------------------------------
--
-- Customers reach /quote with a URL like:
--   https://app.careu.tech/quote?utm_source=we_miss_you
--                                &utm_medium=line
--                                &utm_campaign=retention_2025_03
--                                &utm_branch=c24-thonburi-market
--                                &utm_channel=line
--                                &nid=<notification_id>
--
-- The form persists those fields to the quote_requests row so the
-- attribution layer can trace the funnel: campaign → quote → order.

alter table public.quote_requests
  add column if not exists utm_source                  text,
  add column if not exists utm_medium                  text,
  add column if not exists utm_campaign                text,
  add column if not exists utm_branch                  text,
  add column if not exists utm_channel                 text,
  add column if not exists attributed_notification_id  uuid references public.customer_notifications(id) on delete set null;

create index if not exists quote_requests_utm_campaign_idx
  on public.quote_requests (utm_campaign) where utm_campaign is not null;
create index if not exists quote_requests_attributed_notif_idx
  on public.quote_requests (attributed_notification_id)
  where attributed_notification_id is not null;

-- ---------- 4. orders attribution columns --------------------------------
--
-- When attributeOrderToCampaign matches an order to a campaign, the
-- normalised attribution lands in campaign_response_metrics (Phase 19)
-- but we ALSO denormalise the source onto the order row for fast
-- "which orders came from which campaign" queries.

alter table public.orders
  add column if not exists attribution_source_kind text,
  add column if not exists attribution_source_id   uuid,
  add column if not exists attribution_channel     text;

create index if not exists orders_attribution_idx
  on public.orders (attribution_source_kind, attribution_source_id)
  where attribution_source_id is not null;

-- ============================================================================
-- Verification queries:
--
--   select key, value, branch_id from public.engagement_guardrails order by key;
--   select count(*) from public.campaign_funnel_metrics;     -- 0
--   select column_name from information_schema.columns
--     where table_name='quote_requests' and column_name like 'utm%';
--   select column_name from information_schema.columns
--     where table_name='orders' and column_name like 'attribution%';
--
-- ============================================================================
