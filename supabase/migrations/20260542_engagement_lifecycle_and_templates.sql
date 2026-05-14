-- Customer engagement intelligence + retention triggers + email
-- template system.
--
-- Five new tables ship together because they're operationally one
-- unit — the dashboard, the trigger engine, and the template
-- renderer all reference each other:
--
--   1. customer_engagement_daily — per-customer per-date snapshot
--      computed by /api/cron/engagement-aggregate. Source for the
--      /admin/crm/engagement dashboard's retention trends.
--
--   2. customer_lifecycle_status — current lifecycle classification
--      with the reason text the algorithm produced. Sibling of the
--      Phase 11 customers.lifecycle_stage column (which we keep for
--      backwards compatibility); this table adds the "why" + history.
--
--   3. retention_trigger_jobs — one row per fired trigger. Dedup key
--      = (customer_id, trigger_kind, dedup_window). The cron writes
--      here BEFORE enqueueing the notification so a crash mid-tick
--      doesn't double-fire.
--
--   4. email_templates — current template content (subject + body
--      + variables). RLS owner/HQ only.
--
--   5. email_template_versions — immutable history. Every save
--      writes a new row; restore copies an old row's payload back
--      onto the current row.
--
-- ROLLBACK
--   drop table if exists public.email_template_versions      cascade;
--   drop table if exists public.email_templates              cascade;
--   drop table if exists public.retention_trigger_jobs       cascade;
--   drop table if exists public.customer_lifecycle_status    cascade;
--   drop table if exists public.customer_engagement_daily    cascade;

create extension if not exists "pgcrypto";

-- ---------- 1. customer_engagement_daily ---------------------------------
--
-- Per (customer, metric_date) snapshot. Most fields are cumulative
-- "as of end of day" so dashboards can compute trends without
-- back-filling from raw orders.
--
-- The aggregator writes via UPSERT on (customer_id, metric_date) —
-- repeat runs on the same day update in place.

create table if not exists public.customer_engagement_daily (
  customer_id              uuid not null references public.customers(id) on delete cascade,
  metric_date              date not null,
  /** Cumulative-as-of-end-of-day stats. */
  last_order_at            timestamptz,
  total_orders             integer not null default 0,
  total_spend              numeric(14,2) not null default 0,
  avg_ticket               numeric(14,2) not null default 0,
  days_since_last_order    integer,
  /** Communications counters scoped to the metric_date (NOT cumulative). */
  sms_sent                 integer not null default 0,
  /** sms_opened is left nullable because most Thai SMS aggregators
   *  do not return read receipts. When operator wires a provider
   *  that does, the aggregator populates this. */
  sms_opened               integer,
  line_sent                integer not null default 0,
  email_sent               integer not null default 0,
  campaign_received_count  integer not null default 0,
  campaign_response_count  integer not null default 0,
  /** Operational signals from the order pipeline. */
  no_show_count            integer not null default 0,
  cancellation_count       integer not null default 0,
  updated_at               timestamptz not null default now(),
  primary key (customer_id, metric_date)
);

create index if not exists customer_engagement_daily_date_idx
  on public.customer_engagement_daily (metric_date desc);
create index if not exists customer_engagement_daily_recent_idx
  on public.customer_engagement_daily (customer_id, metric_date desc);

alter table public.customer_engagement_daily enable row level security;

drop policy if exists customer_engagement_daily_admin_read on public.customer_engagement_daily;
create policy customer_engagement_daily_admin_read on public.customer_engagement_daily
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists customer_engagement_daily_branch_read on public.customer_engagement_daily;
create policy customer_engagement_daily_branch_read on public.customer_engagement_daily
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and customer_id in (
      select id from public.customers
      where branch_id = public.current_user_branch_code()
    )
  );

-- ---------- 2. customer_lifecycle_status ---------------------------------
--
-- Current classification per customer. ONE row per customer (UPSERT
-- by customer_id). The aggregator computes new values nightly; the
-- `reason` field captures the algorithm's explanation so an operator
-- can see "at_risk because 95 days since last visit + 4 prior orders
-- + spend > 5000 THB".

create table if not exists public.customer_lifecycle_status (
  customer_id        uuid primary key references public.customers(id) on delete cascade,
  status             text not null check (status in (
    'new','active','repeat','loyal','at_risk','dormant','churned'
  )),
  /** Human-readable explanation. Audited via history table below. */
  reason             text,
  /** Frozen metrics the classification was based on. Restored from
   *  customer_engagement_daily.metric_date = latest. */
  total_orders       integer not null default 0,
  total_spend        numeric(14,2) not null default 0,
  days_since_visit   integer,
  branch_id          text,
  /** When the classification was computed. */
  computed_at        timestamptz not null default now(),
  /** Previous status — null when this is the first classification. */
  previous_status    text,
  /** When the status changed from previous_status. */
  changed_at         timestamptz
);

create index if not exists customer_lifecycle_status_status_idx
  on public.customer_lifecycle_status (status, computed_at desc);
create index if not exists customer_lifecycle_status_branch_idx
  on public.customer_lifecycle_status (branch_id) where branch_id is not null;
create index if not exists customer_lifecycle_status_changed_idx
  on public.customer_lifecycle_status (changed_at desc)
  where changed_at is not null;

alter table public.customer_lifecycle_status enable row level security;

drop policy if exists customer_lifecycle_status_admin_read on public.customer_lifecycle_status;
create policy customer_lifecycle_status_admin_read on public.customer_lifecycle_status
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists customer_lifecycle_status_branch_read on public.customer_lifecycle_status;
create policy customer_lifecycle_status_branch_read on public.customer_lifecycle_status
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 3. retention_trigger_jobs ------------------------------------
--
-- One row per fired retention trigger. Dedup logic lives in the
-- service: before enqueueing, the cron checks for an existing row
-- with the same (customer_id, trigger_kind) inside the dedup window.
--
-- Trigger kinds:
--   • no_visit_x_days       — no order in N days
--   • pickup_overdue        — ready-for-pickup past grace window
--   • inactive_vip          — VIP/gold tier with no_visit
--   • high_spend_dormant    — lifetime_spend ≥ T with no_visit
--   • birthday_month        — birthday this month (when DOB available)
--   • first_time_followup   — first order completed within last N days

create table if not exists public.retention_trigger_jobs (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references public.customers(id) on delete cascade,
  trigger_kind        text not null check (trigger_kind in (
    'no_visit_x_days',
    'pickup_overdue',
    'inactive_vip',
    'high_spend_dormant',
    'birthday_month',
    'first_time_followup'
  )),
  /** Channel used for this trigger. */
  channel             text not null check (channel in ('sms','line','email')),
  /** Template the trigger rendered through. NULL when the body was
   *  built inline by the service (legacy). */
  template_id         uuid,
  /** Resulting customer_notifications row id. NULL when skipped
   *  before enqueue (preferences / dedup / quiet hours / rate-limit). */
  notification_id     uuid references public.customer_notifications(id) on delete set null,
  /** dispatch | skipped | dead_letter — set by the trigger service
   *  at attempt time, NOT by the dispatch worker. The dispatch
   *  worker updates the linked customer_notifications row; this
   *  status reflects "did we even try". */
  status              text not null default 'queued'
                      check (status in ('queued','dispatched','skipped','failed')),
  /** When skipped, the reason from communicationPolicyService /
   *  broadcastPolicyService / dedup check. */
  skip_reason         text,
  /** Frozen reason the trigger fired — explainable context for the
   *  admin who reviews the trigger log. */
  fired_reason        text,
  branch_id           text,
  created_at          timestamptz not null default now(),
  processed_at        timestamptz
);

create index if not exists retention_trigger_jobs_dedup_idx
  on public.retention_trigger_jobs (customer_id, trigger_kind, created_at desc);
create index if not exists retention_trigger_jobs_status_idx
  on public.retention_trigger_jobs (status, created_at desc);
create index if not exists retention_trigger_jobs_branch_idx
  on public.retention_trigger_jobs (branch_id, created_at desc)
  where branch_id is not null;
create index if not exists retention_trigger_jobs_kind_idx
  on public.retention_trigger_jobs (trigger_kind, created_at desc);

alter table public.retention_trigger_jobs enable row level security;

drop policy if exists retention_trigger_jobs_admin_read on public.retention_trigger_jobs;
create policy retention_trigger_jobs_admin_read on public.retention_trigger_jobs
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists retention_trigger_jobs_branch_read on public.retention_trigger_jobs;
create policy retention_trigger_jobs_branch_read on public.retention_trigger_jobs
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 4. email_templates -------------------------------------------
--
-- One row per named template. `slug` is the operator-visible
-- identifier the trigger engine references. `body_html` carries the
-- rendered marketing copy; `body_plain` is the SMS-safe fallback.
-- Subject + preview_text + variables are static metadata.
--
-- Editing a template writes a new row to email_template_versions
-- (audit trail) before updating in place.

create table if not exists public.email_templates (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique,
  /** Operator-visible name. */
  name              text not null,
  /** Subject line — interpolation allowed (e.g. "งานของ {{customer_name}} พร้อมรับแล้ว"). */
  subject           text not null,
  /** Preview text shown in inbox before opening — short, also
   *  interpolated. */
  preview_text      text,
  /** Plain-text body. Falls back here when the channel is SMS or
   *  the recipient's client doesn't render HTML. */
  body_plain        text not null,
  /** HTML body. Optional — when null we send body_plain wrapped in
   *  a minimal HTML shell at render time. */
  body_html         text,
  /** Required-variable list. Render fails when a variable is missing
   *  from the input context. JSONB so future template kinds can
   *  carry rich schemas. */
  variables         jsonb not null default '[]'::jsonb,
  /** Channels this template targets. The trigger engine picks the
   *  right body field by channel. */
  channels          text[] not null default '{}',
  /** Whether the template is currently active (i.e. visible to the
   *  trigger engine). Soft-disable without deleting history. */
  enabled           boolean not null default true,
  /** Current version number. Starts at 1, increments on each save. */
  current_version   integer not null default 1,
  branch_id         text,
  created_by        uuid,
  updated_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists email_templates_enabled_idx
  on public.email_templates (enabled, slug);
create index if not exists email_templates_branch_idx
  on public.email_templates (branch_id) where branch_id is not null;

create or replace function public.touch_email_templates_updated() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists email_templates_touch on public.email_templates;
create trigger email_templates_touch
  before update on public.email_templates
  for each row execute procedure public.touch_email_templates_updated();

alter table public.email_templates enable row level security;

drop policy if exists email_templates_admin_full on public.email_templates;
create policy email_templates_admin_full on public.email_templates
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists email_templates_read on public.email_templates;
create policy email_templates_read on public.email_templates
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 5. email_template_versions -----------------------------------
--
-- Immutable history. Every save on email_templates creates a new
-- row here BEFORE the update. Restore copies a chosen row back onto
-- the current template (and itself writes a new version row).
--
-- The 'security: template history immutable' requirement is enforced
-- by NEVER exposing UPDATE/DELETE policies — only INSERT + SELECT.

create table if not exists public.email_template_versions (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid not null references public.email_templates(id) on delete cascade,
  version         integer not null,
  /** Snapshot of the template's content at this version. */
  name            text not null,
  subject         text not null,
  preview_text    text,
  body_plain      text not null,
  body_html       text,
  variables       jsonb not null default '[]'::jsonb,
  channels        text[] not null default '{}',
  /** Captured by the API at save time. */
  edited_by       uuid,
  edit_reason     text,
  created_at      timestamptz not null default now()
);

create unique index if not exists email_template_versions_uniq
  on public.email_template_versions (template_id, version);
create index if not exists email_template_versions_template_idx
  on public.email_template_versions (template_id, created_at desc);

alter table public.email_template_versions enable row level security;

-- Read-only for owner/HQ. NO insert/update/delete policies — the
-- service-role admin client is the only writer. This is the
-- "immutable history" guarantee.
drop policy if exists email_template_versions_admin_read on public.email_template_versions;
create policy email_template_versions_admin_read on public.email_template_versions
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- ---------- 6. Bootstrap default templates -------------------------------
--
-- Operators don't have to start from scratch. Four common retention
-- templates ship; they can be edited / disabled freely.

insert into public.email_templates
  (slug, name, subject, preview_text, body_plain, channels, variables, enabled)
values
  (
    'overdue_pickup_reminder',
    'แจ้งเตือนงานยังไม่มารับ',
    'งาน {{job_id}} ของคุณ {{customer_name}} ยังรอที่ {{branch_name}}',
    'แวะมารับงานเมื่อสะดวกนะคะ',
    'สวัสดี {{customer_name}}, งาน {{job_id}} ของคุณยังรออยู่ที่ {{branch_name}} แวะมารับเมื่อสะดวกนะคะ',
    array['sms','line']::text[],
    '["customer_name","branch_name","job_id"]'::jsonb,
    true
  ),
  (
    'we_miss_you',
    'คิดถึงลูกค้า',
    '{{branch_name}} คิดถึงคุณ {{customer_name}}',
    'ไม่ได้เจอกันสักพักแล้วนะคะ',
    'สวัสดี {{customer_name}}, ไม่ได้เจอกันที่ {{branch_name}} นานแล้ว — มีโปรเมื่อกลับมาใช้บริการ',
    array['sms','line']::text[],
    '["customer_name","branch_name"]'::jsonb,
    true
  ),
  (
    'thank_you_followup',
    'ขอบคุณที่ใช้บริการ',
    'ขอบคุณ {{customer_name}} ที่ใช้บริการ {{branch_name}}',
    'หวังว่าจะได้เจอกันอีกครั้ง',
    'ขอบคุณ {{customer_name}} ที่ใช้บริการ {{branch_name}} เมื่อ {{last_visit_date}} — หวังว่าจะได้เจอกันอีก',
    array['sms','line','email']::text[],
    '["customer_name","branch_name","last_visit_date"]'::jsonb,
    true
  ),
  (
    'vip_reactivation',
    'โปรพิเศษสำหรับลูกค้า VIP',
    'คุณ {{customer_name}} — โปรพิเศษเฉพาะ VIP',
    'ขอบคุณที่อยู่กับเรา',
    'คุณ {{customer_name}}, ขอบคุณที่อยู่กับ {{branch_name}} มาตลอด — มีสิทธิ์พิเศษรอคุณอยู่',
    array['sms','line']::text[],
    '["customer_name","branch_name"]'::jsonb,
    true
  )
on conflict (slug) do nothing;

-- ============================================================================
-- Verification queries:
--
--   select count(*) from public.customer_engagement_daily;   -- 0
--   select count(*) from public.customer_lifecycle_status;   -- 0
--   select count(*) from public.retention_trigger_jobs;      -- 0
--   select slug from public.email_templates order by slug;   -- 4 defaults
--   select count(*) from public.email_template_versions;     -- 0
--
-- ============================================================================
