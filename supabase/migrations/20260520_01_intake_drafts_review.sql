-- Phase A — manual front-counter job code + admin convert support.
--
-- Real-shop reality: the front counter does NOT use the auto-generated
-- DYYMMDD-NNN draft_code. Staff write the SAME number on the bag tag that
-- the shop's running queue tells them to (continuing from yesterday's last
-- job), and that exact code becomes the order's job_id when an owner/admin
-- converts the draft into a real order. The auto-generated draft_code stays
-- as a system-internal short id (fallback only — see app code).
--
-- Additive only. Every existing draft, RLS rule, and downstream consumer
-- keeps working. No table is altered destructively, no NOT NULL added.
--
-- Safe to re-run.

create extension if not exists "pgcrypto";

-- ---------- intake_drafts: review + convert support columns ---------------

-- manual_job_code — the user-typed code from the mobile capture form.
-- Becomes orders.job_id on convert. Branch-scoped uniqueness (allows null,
-- allows reuse across branches, allows reuse after a draft is CANCELLED).
alter table public.intake_drafts
  add column if not exists manual_job_code text;

-- customer_id — populated by the convert route when it finds or creates
-- the matching customers row, so the draft history shows the real link.
alter table public.intake_drafts
  add column if not exists customer_id uuid;

-- approved_price — the price the admin confirmed when pressing
-- "Approve & Create Order". Sourced from service_price_master via the pure
-- calculateServiceQuote engine — never from the request body.
alter table public.intake_drafts
  add column if not exists approved_price numeric(10,2);

-- Best-effort abuse triage on the public mobile endpoint.
alter table public.intake_drafts
  add column if not exists client_ip text;
alter table public.intake_drafts
  add column if not exists client_user_agent text;

-- ---------- Uniqueness ---------------------------------------------------

-- Branch-scoped, exclude null + CANCELLED so a cancelled draft frees the
-- code for reuse. Comparing text columns to literal strings is IMMUTABLE,
-- so this is a legal predicate for a partial unique index.
create unique index if not exists intake_drafts_manual_job_code_branch_uniq
  on public.intake_drafts (branch_id, manual_job_code)
  where manual_job_code is not null
    and status <> 'CANCELLED';

create index if not exists intake_drafts_manual_job_code_idx
  on public.intake_drafts (manual_job_code);

create index if not exists intake_drafts_customer_id_idx
  on public.intake_drafts (customer_id);

-- ============================================================================
-- Verification:
--   \d public.intake_drafts                       -- new columns present
--   select indexdef from pg_indexes
--     where tablename = 'intake_drafts'
--       and indexname = 'intake_drafts_manual_job_code_branch_uniq';
--   -- Should show the partial unique index on (branch_id, manual_job_code).
-- ============================================================================
