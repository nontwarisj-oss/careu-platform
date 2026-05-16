-- Phase 27A — Customer portal polish.
--
-- Two additive changes — no rewrites, no data backfill.
--
--   1. public.customers — four "saved preference" columns the
--      customer manages from /portal/preferences:
--        preferred_branch_id       — branches.code slug
--        preferred_language        — 'th' | 'en'
--        preferred_contact_channel — 'sms' | 'line' | 'email'
--        preferred_pickup_time     — 'morning' | 'afternoon' | 'evening'
--      All nullable — absent = no stated preference.
--
--   2. public.customer_notifications — customer_read_at, the
--      read/unread marker for the new /portal/notifications centre.
--      NULL = unread. Set when the customer opens the centre.
--
-- All additive + idempotent.
--
-- ROLLBACK
--   alter table public.customers drop column if exists preferred_branch_id,
--     drop column if exists preferred_language,
--     drop column if exists preferred_contact_channel,
--     drop column if exists preferred_pickup_time;
--   alter table public.customer_notifications
--     drop column if exists customer_read_at;

begin;

alter table public.customers
  add column if not exists preferred_branch_id       text,
  add column if not exists preferred_language        text,
  add column if not exists preferred_contact_channel text,
  add column if not exists preferred_pickup_time     text;

alter table public.customer_notifications
  add column if not exists customer_read_at timestamptz;

-- The notification centre's hot query: a customer's unread rows.
create index if not exists customer_notifications_customer_unread_idx
  on public.customer_notifications (customer_id, created_at desc)
  where customer_read_at is null;

commit;
