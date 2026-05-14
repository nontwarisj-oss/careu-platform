-- Phone-change request flow + dispatch worker housekeeping.
--
-- Two changes:
--
--   1. public.phone_change_requests — pending phone-change requests
--      issued from the customer portal. The customer asks to swap their
--      phone, an OTP is sent to the NEW number, and on verify the
--      customer's row is updated. The request row itself stays as an
--      audit record (status: pending / verified / cancelled / expired).
--
--   2. Indexes on public.customer_notifications to support the new
--      dispatch worker query patterns. The existing pending-index from
--      `20260535` already covers `status IN ('queued','sending')` but
--      the worker also needs per-channel queries for the admin
--      monitoring UI.

create extension if not exists "pgcrypto";

-- ---------- 1. phone_change_requests -------------------------------------

create table if not exists public.phone_change_requests (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references public.customers(id) on delete cascade,
  /** Normalised current phone — captured at issue time so we can audit
   *  what we changed from. */
  current_phone   text not null,
  /** Normalised new phone the customer wants to switch to. */
  new_phone       text not null,
  /** sha256(salt || code) where salt is the row id. */
  code_hash       text not null,
  expires_at      timestamptz not null,
  verified_at     timestamptz,
  cancelled_at    timestamptz,
  attempts        integer not null default 0,
  /** IP / UA at request time. */
  request_meta    jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists phone_change_requests_customer_idx
  on public.phone_change_requests (customer_id, created_at desc);
create index if not exists phone_change_requests_pending_idx
  on public.phone_change_requests (customer_id, expires_at)
  where verified_at is null and cancelled_at is null;
-- Prevent two concurrent pending requests claiming the same new_phone —
-- protects against an attacker claiming someone else's phone in parallel.
create unique index if not exists phone_change_requests_new_phone_pending_uniq
  on public.phone_change_requests (new_phone)
  where verified_at is null and cancelled_at is null;

alter table public.phone_change_requests enable row level security;

-- Only owner / hq_admin can read the audit table directly. Writes go
-- through the service-role admin client from /api/portal/phone-change/*.
drop policy if exists phone_change_requests_admin_read on public.phone_change_requests;
create policy phone_change_requests_admin_read on public.phone_change_requests
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- ---------- 2. dispatch worker indexes -----------------------------------
--
-- Already-indexed today via 20260535:
--   • customer_notifications_pending_idx (status, send_after)
--   • customer_notifications_customer_idx (customer_id, created_at desc)
--   • customer_notifications_kind_idx (kind, created_at desc)
--   • customer_notifications_branch_idx (branch_id) where branch_id is not null
--
-- Adding two more for the /admin/dispatch monitor + worker triage:

create index if not exists customer_notifications_channel_status_idx
  on public.customer_notifications (channel, status, send_after);
create index if not exists customer_notifications_failed_idx
  on public.customer_notifications (status, attempts)
  where status in ('failed', 'queued') and attempts > 0;

-- ============================================================================
-- Verification queries:
--
--   select count(*) from public.phone_change_requests;       -- 0
--   select indexname from pg_indexes where schemaname='public'
--     and tablename in ('phone_change_requests','customer_notifications')
--   order by indexname;
--
-- ============================================================================
