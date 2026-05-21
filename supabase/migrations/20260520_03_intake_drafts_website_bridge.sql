-- Phase W2 - bridge public.quote_requests into the central intake-draft
-- workflow. Additive only. Existing /quote, /mobile-intake, /admin/intake-
-- drafts, convert and payment flows are untouched.
--
-- Two new nullable/defaulted columns on public.intake_drafts:
--   intake_source     : where the draft originated. Default 'mobile_intake'
--                       so every existing row stays valid without a backfill.
--   quote_request_id  : FK to public.quote_requests. Set only when the
--                       draft was created by the website bridge.
--
-- Partial UNIQUE index makes the bridge idempotent: a retried /quote POST
-- never inserts a second draft for the same quote_request_id.
--
-- Safe to re-run (every statement uses IF NOT EXISTS).

create extension if not exists "pgcrypto";

alter table public.intake_drafts
  add column if not exists intake_source text not null default 'mobile_intake';

-- CHECK constraint added separately so the migration is safe to re-run
-- against an environment where the column already exists with the same
-- text values - DO block silently skips if the constraint is present.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'intake_drafts_intake_source_check'
  ) then
    alter table public.intake_drafts
      add constraint intake_drafts_intake_source_check
      check (intake_source in ('mobile_intake','website','line_oa'));
  end if;
end $$;

alter table public.intake_drafts
  add column if not exists quote_request_id uuid
    references public.quote_requests(id) on delete set null;

-- Idempotency: at most one intake_drafts row per quote_request_id.
create unique index if not exists intake_drafts_quote_request_id_uniq
  on public.intake_drafts (quote_request_id)
  where quote_request_id is not null;

-- Queue filter index - "ที่มา: เว็บไซต์" chip in /admin/intake-drafts
-- can filter without a seq scan even after thousands of drafts.
create index if not exists intake_drafts_intake_source_idx
  on public.intake_drafts (intake_source);

-- ============================================================================
-- Verification:
--   select column_name from information_schema.columns
--    where table_name = 'intake_drafts'
--      and column_name in ('intake_source','quote_request_id');
--   -- expect 2 rows.
--
--   select indexname from pg_indexes
--    where tablename = 'intake_drafts'
--      and indexname in (
--        'intake_drafts_quote_request_id_uniq',
--        'intake_drafts_intake_source_idx'
--      );
--   -- expect 2 rows.
-- ============================================================================
