-- Phase W2 prerequisite — compatibility shim for production.
--
-- Production DB is missing public.quote_requests. The full migration
-- that introduced it (20260534_public_website_and_crm_foundation.sql)
-- transitively depends on:
--   • public.users   (20260516_rbac_finance.sql)
--   • public.profiles (20260521_enterprise_foundation.sql)
--   • public.current_user_role() + current_user_branch_code()
--     (20260522_auth_bridge_rls.sql)
-- None of those are in production, and applying that whole chain
-- enables RLS on orders + customers with auth.uid()-based policies
-- that the current cookieless staff session model cannot satisfy.
--
-- This shim creates ONLY public.quote_requests with the minimum
-- columns that app/api/public/quote/route.ts already writes, plus
-- the columns the W2 bridge (lib/intakeDraftBridge.ts) needs to read
-- via the new intake_drafts.quote_request_id FK.
--
-- Idempotent. Safe to re-run. No application code changes required.
-- Does NOT create or modify public.users, public.profiles, the auth
-- bridge, pricing, payment, document, or orders tables.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- --
-- public.quote_requests
-- ---------------------------------------------------------------- --
create table if not exists public.quote_requests (
  id uuid primary key default gen_random_uuid(),
  customer_name text,
  customer_phone text not null,
  customer_email text,
  contact_method text,
  branch_code text,
  service_category text,
  notes text,
  photos jsonb not null default '[]'::jsonb,
  urgency text,
  fulfilment_preference text,
  status text not null default 'new',
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_branch text,
  utm_channel text,
  attributed_notification_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- --
-- Indexes
-- ---------------------------------------------------------------- --
-- Admin queue lists "new" first, newest at the top. Composite covers
-- both filter + order in one scan.
create index if not exists quote_requests_status_created_idx
  on public.quote_requests (status, created_at desc);

-- Partial index — most rows have a branch_code, but the column is
-- nullable. Keep the index slim by skipping NULLs.
create index if not exists quote_requests_branch_code_idx
  on public.quote_requests (branch_code)
  where branch_code is not null;

-- Admin lookup by inbound phone number when triaging.
create index if not exists quote_requests_customer_phone_idx
  on public.quote_requests (customer_phone);

-- ---------------------------------------------------------------- --
-- RLS
-- ---------------------------------------------------------------- --
-- Enable RLS with NO policies. Reads + writes go through the
-- service-role admin client (getSupabaseAdmin), which bypasses RLS.
-- The anon key cannot reach this table directly — /api/public/quote
-- proxies the insert server-side. This matches the access model the
-- rest of the codebase already uses (intake_drafts, intake_draft_media,
-- orders) and avoids creating policies that depend on the missing
-- public.current_user_role() helper.
alter table public.quote_requests enable row level security;
