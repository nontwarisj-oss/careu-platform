-- LINE OA integration foundation.
--
-- ============================================================================
-- BEFORE YOU APPLY THIS MIGRATION
-- ============================================================================
--
-- Apply order: AFTER 20260526. Depends on:
--   • public.customers, public.orders, public.branches, public.profiles
--   • public.current_user_role() / current_user_branch_code()         (20260522)
--
-- Additive + idempotent. No existing schema is changed.
--
-- This migration ships the DATA model for LINE OA messaging. The MVP does
-- not implement a LINE follow webhook (customer-side) yet — rows in
-- public.customer_line_links will start populating when that lands in a
-- future migration. Until then, the MVP supports per-customer manual
-- linkage (admin SQL or the upcoming /admin/customer-line UI) so the
-- staff can test send flows.
--
-- ============================================================================
-- WHAT THIS MIGRATION SHIPS
-- ============================================================================
--
--   • public.customer_line_links  — customer ↔ LINE user mapping +
--                                    per-channel notification preferences
--   • public.line_message_log     — every outbound LINE send attempt
--   • public.branch_line_configs  — per-branch channel tokens (falls
--                                    back to env vars when row absent)
--   • RLS on all three
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--
--   drop policy if exists branch_line_configs_admin_read on public.branch_line_configs;
--   drop table if exists public.branch_line_configs;
--   drop policy if exists line_message_log_admin_read on public.line_message_log;
--   drop policy if exists line_message_log_branch_read on public.line_message_log;
--   drop table if exists public.line_message_log;
--   drop policy if exists customer_line_links_admin_full on public.customer_line_links;
--   drop policy if exists customer_line_links_branch_read on public.customer_line_links;
--   drop table if exists public.customer_line_links;
--
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------- 1. customer_line_links ----------------------------------------
-- One row per customer ↔ LINE user pairing. A single customer can later
-- have multiple LINE accounts (rare); the unique constraint is on the
-- LINE user id, NOT the customer id, so we can capture that.
--
-- consented_at is the PDPA consent timestamp — set when the customer
-- opts in via the follow flow. unsubscribed_at takes precedence over
-- any individual notify_* preference.

create table if not exists public.customer_line_links (
  id                       uuid primary key default gen_random_uuid(),
  customer_id              uuid references public.customers(id) on delete cascade,
  line_user_id             text not null,
  display_name             text,
  picture_url              text,
  notify_order_received    boolean not null default true,
  notify_order_ready       boolean not null default true,
  notify_pickup_reminder   boolean not null default true,
  notify_receipt           boolean not null default true,
  consented_at             timestamptz,
  unsubscribed_at          timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid,
  updated_by               uuid
);

create unique index if not exists customer_line_links_line_user_id_uniq
  on public.customer_line_links (line_user_id);
create index if not exists customer_line_links_customer_id_idx
  on public.customer_line_links (customer_id);
create index if not exists customer_line_links_consented_idx
  on public.customer_line_links (consented_at) where consented_at is not null;

create or replace function public.touch_customer_line_link_updated() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  begin
    new.updated_by := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  exception when others then
    new.updated_by := old.updated_by;
  end;
  return new;
end $$;

drop trigger if exists customer_line_links_touch_updated on public.customer_line_links;
create trigger customer_line_links_touch_updated
  before update on public.customer_line_links
  for each row execute function public.touch_customer_line_link_updated();

alter table public.customer_line_links enable row level security;

-- owner / hq_admin: read + write any link.
drop policy if exists customer_line_links_admin_full on public.customer_line_links;
create policy customer_line_links_admin_full on public.customer_line_links
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

-- branch_manager / front_staff: read links for customers in their branch
-- (joined via customers.branch_id). They cannot create / unsubscribe —
-- that's an admin-controlled flow per PDPA.
drop policy if exists customer_line_links_branch_read on public.customer_line_links;
create policy customer_line_links_branch_read on public.customer_line_links
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and customer_id in (
      select c.id from public.customers c
      where c.branch_id = public.current_user_branch_code()
         or c.branch_id is null
    )
  );

-- ---------- 2. line_message_log -------------------------------------------
-- Every send attempt. status='sent' on success, 'failed' on error,
-- 'skipped' when the orchestrator chose not to send (no LINE link,
-- customer unsubscribed, preference off). Append-only.

create table if not exists public.line_message_log (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid references public.customers(id) on delete set null,
  order_id        uuid references public.orders(id) on delete set null,
  branch_id       text,
  line_user_id    text,
  kind            text not null check (kind in (
                    'order_received',
                    'order_ready',
                    'pickup_reminder',
                    'receipt',
                    'manual',
                    'test'
                  )),
  message_text    text,
  payload         jsonb,
  status          text not null default 'pending' check (status in (
                    'pending','sent','failed','skipped'
                  )),
  error_reason    text,
  attempts        integer not null default 0,
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  created_by      uuid
);

create index if not exists line_message_log_customer_idx
  on public.line_message_log (customer_id);
create index if not exists line_message_log_order_idx
  on public.line_message_log (order_id);
create index if not exists line_message_log_kind_idx
  on public.line_message_log (kind);
create index if not exists line_message_log_status_idx
  on public.line_message_log (status);
create index if not exists line_message_log_branch_idx
  on public.line_message_log (branch_id);
create index if not exists line_message_log_created_at_idx
  on public.line_message_log (created_at desc);

alter table public.line_message_log enable row level security;

-- owner / hq_admin: all rows. branch_manager: own branch.
-- No INSERT policy — only the orchestrator (service-role or app-with-JWT)
-- writes here.
drop policy if exists line_message_log_admin_read on public.line_message_log;
create policy line_message_log_admin_read on public.line_message_log
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists line_message_log_branch_read on public.line_message_log;
create policy line_message_log_branch_read on public.line_message_log
  for select to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and branch_id = public.current_user_branch_code()
  );

-- ---------- 3. branch_line_configs ----------------------------------------
-- Per-branch LINE OA channel credentials. Reads happen only via
-- lib/lineConfig.ts using the service-role client (no read policy for any
-- authenticated role). Tokens never leave the server.
--
-- When no row exists for a branch, the orchestrator falls back to the
-- global env vars (LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET /
-- LINE_OA_ID).

create table if not exists public.branch_line_configs (
  branch_id              uuid primary key references public.branches(id) on delete cascade,
  channel_access_token   text,
  channel_secret         text,
  oa_basic_id            text,
  oa_display_name        text,
  /** Auto-send toggles per kind, default off so the MVP doesn't fire
      unsolicited messages on every order create. */
  auto_send_order_received   boolean not null default false,
  auto_send_order_ready      boolean not null default false,
  auto_send_pickup_reminder  boolean not null default false,
  configured             boolean generated always as (
                           channel_access_token is not null
                         ) stored,
  last_rotated_at        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists branch_line_configs_configured_idx
  on public.branch_line_configs (configured);

create or replace function public.touch_branch_line_config_updated() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.channel_access_token is distinct from old.channel_access_token then
    new.last_rotated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists branch_line_configs_touch_updated on public.branch_line_configs;
create trigger branch_line_configs_touch_updated
  before update on public.branch_line_configs
  for each row execute function public.touch_branch_line_config_updated();

alter table public.branch_line_configs enable row level security;

-- Read-policy intentionally absent. Service-role bypasses RLS — that's
-- the only path that should ever see the token. A safer-display view
-- (without the token) lives in the next phase when the admin UI lands.
-- Until then, every read of branch_line_configs requires service role.
-- The application still works because lib/lineConfig.ts goes through
-- getSupabaseAdmin().

-- ============================================================================
-- Verification queries you can run after applying:
--
--   select count(*) from public.customer_line_links;     -- 0 initially
--   select count(*) from public.line_message_log;        -- 0 initially
--   select count(*) from public.branch_line_configs;     -- 0 initially
--   select policyname from pg_policies
--     where tablename in ('customer_line_links','line_message_log','branch_line_configs');
--
-- ============================================================================
