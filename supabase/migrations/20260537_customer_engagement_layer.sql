-- Customer engagement layer — preferences + dispatch telemetry + activity
-- index housekeeping.
--
-- Three additions:
--
--   1. public.customer_notification_preferences — one row per customer.
--      Toggle SMS / LINE / email + opt-in to specific message kinds
--      (pickup reminders, order status alerts, promotions). The
--      lifecycle notifier consults this at enqueue time so a customer
--      who's opted out never has a notification queued in the first
--      place — saves provider quota AND audit-log noise.
--
--   2. public.notification_dispatch_log — one row per dispatch ATTEMPT
--      (sibling of public.customer_notifications, which is the QUEUE).
--      Where the queue tracks "what we want to deliver", this table
--      tracks "what actually happened". The dispatch worker writes one
--      row per attempt with outcome + latency + retryable flag.
--      Aggregated by /admin/dispatch into success rate, retry depth,
--      and dead-letter trend.
--
--   3. Index housekeeping on public.customer_activity to support the
--      portal activity feed (customer-scoped, time-ordered).
--
-- All additions are idempotent + additive. Existing data untouched.
--
-- ROLLBACK
--   drop table if exists public.notification_dispatch_log cascade;
--   drop table if exists public.customer_notification_preferences cascade;

create extension if not exists "pgcrypto";

-- ---------- 1. customer_notification_preferences -------------------------
--
-- One row per customer. Default values mean "opted-in to transactional,
-- opted-out of promotional" — matches reasonable Thai opt-in norms.
-- The lifecycle notifier reads this row and skips channels the customer
-- has disabled.

create table if not exists public.customer_notification_preferences (
  customer_id           uuid primary key references public.customers(id) on delete cascade,
  /** Channel master toggles. Defaults match reasonable opt-in norms. */
  sms_enabled           boolean not null default true,
  line_enabled          boolean not null default true,
  email_enabled         boolean not null default false,
  /** Per-kind toggles. Each kind is independent — a customer can keep
   *  pickup reminders but disable promotional pushes. */
  pickup_reminders      boolean not null default true,
  order_status_alerts   boolean not null default true,
  payment_alerts        boolean not null default true,
  /** Promotional / marketing — default OFF. The customer must explicitly
   *  opt-in via the preference center. */
  promotional           boolean not null default false,
  /** When the customer last changed any of these toggles. NULL until
   *  the first edit. */
  last_updated_at       timestamptz,
  /** Per-edit audit lives in customer_activity; this column is just for
   *  "when did the customer last touch their prefs?". */
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists customer_notification_preferences_updated_idx
  on public.customer_notification_preferences (updated_at desc);

alter table public.customer_notification_preferences enable row level security;

-- Customers manage their own preferences via /api/portal/preferences
-- (service-role admin client). Admins read for the /admin/customers/[id]
-- view.
drop policy if exists customer_notification_preferences_admin_full
  on public.customer_notification_preferences;
create policy customer_notification_preferences_admin_full
  on public.customer_notification_preferences
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists customer_notification_preferences_branch_read
  on public.customer_notification_preferences;
create policy customer_notification_preferences_branch_read
  on public.customer_notification_preferences
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and customer_id in (
      select id from public.customers
      where branch_id = public.current_user_branch_code()
    )
  );

-- ---------- 2. notification_dispatch_log ---------------------------------
--
-- Append-only telemetry. ONE row per dispatch ATTEMPT. The dispatch
-- worker writes here regardless of outcome — the admin observability
-- view aggregates over it.
--
-- We intentionally keep this separate from customer_notifications
-- (the queue) so:
--   • The queue stays tidy — one row per intent, updated in place.
--   • The log is append-only — every attempt is preserved for forensics.

create table if not exists public.notification_dispatch_log (
  id                  uuid primary key default gen_random_uuid(),
  notification_id     uuid references public.customer_notifications(id) on delete set null,
  customer_id         uuid references public.customers(id) on delete set null,
  branch_id           text,
  channel             text not null,
  kind                text not null,
  /** sent | failed | skipped */
  outcome             text not null check (outcome in ('sent','failed','skipped')),
  /** Whether the worker decided the failure could be retried. */
  retryable           boolean not null default false,
  /** Attempt index when this log row was written (1-based). */
  attempt             integer not null default 1,
  /** End-to-end milliseconds spent in dispatchRow — provider latency
   *  proxy. Null when we couldn't measure (e.g. skipped before send). */
  latency_ms          integer,
  /** Provider name for the SMS adapter case ('console', 'twilio', ...).
   *  Null for LINE / email / in_app. */
  provider            text,
  /** Free-form provider details — Twilio message SID, LINE request id,
   *  error code, etc. */
  details             jsonb not null default '{}'::jsonb,
  reason              text,
  created_at          timestamptz not null default now()
);

create index if not exists notification_dispatch_log_created_idx
  on public.notification_dispatch_log (created_at desc);
create index if not exists notification_dispatch_log_notification_idx
  on public.notification_dispatch_log (notification_id);
create index if not exists notification_dispatch_log_outcome_idx
  on public.notification_dispatch_log (outcome, channel, created_at desc);
create index if not exists notification_dispatch_log_customer_idx
  on public.notification_dispatch_log (customer_id, created_at desc)
  where customer_id is not null;

alter table public.notification_dispatch_log enable row level security;

drop policy if exists notification_dispatch_log_admin_read
  on public.notification_dispatch_log;
create policy notification_dispatch_log_admin_read
  on public.notification_dispatch_log
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists notification_dispatch_log_branch_read
  on public.notification_dispatch_log;
create policy notification_dispatch_log_branch_read
  on public.notification_dispatch_log
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 3. customer_activity housekeeping ----------------------------
--
-- The activity feed query is "by customer_id, ordered by created_at
-- desc, limit 50". That's covered by customer_activity_customer_idx
-- from `20260534`. The portal also wants to filter on a curated subset
-- of kinds (excluding admin-only ones); the kind filter is OR-merged
-- in-app so we don't add a per-kind partial index.

-- ---------- 4. order audit_log action enum -------------------------------
--
-- Lifecycle notifier adds two new action kinds on order_audit_log:
--   • 'repair_started' — operator marked the order in-progress
--   • 'qc_started'     — internal QC checkpoint (operator-facing only)
--   • 'ready_for_pickup' — pickup-ready signal
--   • 'overdue_pickup' — automated overdue marker (cron)
--
-- The existing CHECK constraint from `20260520` + `20260526` already
-- includes 'status_changed' and 'payment_changed'. We extend it here
-- to allow the more granular lifecycle markers without losing the
-- existing rows.
--
-- Drop + recreate is safe — the table holds < 1000 rows in production
-- today and the CHECK is NOT VALID semantics. Tolerant of repeated runs.

do $$
begin
  alter table public.order_audit_log
    drop constraint if exists order_audit_log_action_check;
  alter table public.order_audit_log
    add constraint order_audit_log_action_check
    check (action in (
      'created',
      'status_changed',
      'payment_changed',
      'cost_updated',
      'cancelled',
      'sync_pushed',
      'sync_failed',
      'assigned',
      'receipt_regenerated',
      'repair_started',
      'qc_started',
      'ready_for_pickup',
      'overdue_pickup',
      'lifecycle_notified'
    ))
    not valid;
exception when undefined_table then
  -- order_audit_log not yet created on this DB; skip.
  null;
end $$;

-- ============================================================================
-- Verification queries:
--
--   select count(*) from public.customer_notification_preferences;  -- 0
--   select count(*) from public.notification_dispatch_log;          -- 0
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--     where conname = 'order_audit_log_action_check';
--
-- ============================================================================
