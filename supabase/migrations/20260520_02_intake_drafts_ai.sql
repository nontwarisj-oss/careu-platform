-- Phase B foundation - AI classification + owner confirmation fields.
--
-- Additive only. Two groups of fields:
--   1. ai_* : populated by /api/admin/intake-drafts/[id]/classify.
--             Phase B is rule-based (lib/intakeClassifier.ts); Phase C
--             will swap the engine for a real vision/text model without
--             touching the column shape.
--   2. confirmed_* : the owner's verdict after reviewing the AI block.
--                    A draft is not "reviewed" until these are saved.
--
-- review_status drives the queue UI badge:
--   needs_review  -> amber  (mobile draft just landed)
--   reviewed      -> green  (owner saved confirmed_* fields)
--   converted     -> gray   (converted_order_id is set)
--
-- Some ai_* columns already exist from 20260559_intake_drafts.sql
-- (ai_summary, ai_suggested_category, ai_suggested_service_code,
-- ai_confidence). The new add-column statements use IF NOT EXISTS so
-- this migration is safe to re-run and never duplicates a column.

create extension if not exists "pgcrypto";

-- ---------- ai_* suggestion fields ----------------------------------------
alter table public.intake_drafts
  add column if not exists ai_status text default 'pending';
alter table public.intake_drafts
  add column if not exists ai_garment_type text;
alter table public.intake_drafts
  add column if not exists ai_repair_category text;
alter table public.intake_drafts
  add column if not exists ai_repair_area text;
alter table public.intake_drafts
  add column if not exists ai_difficulty text;
alter table public.intake_drafts
  add column if not exists ai_suggested_price numeric(10,2);
alter table public.intake_drafts
  add column if not exists ai_needs_human_review boolean default true;

-- ---------- confirmed_* (owner-edited) fields -----------------------------
alter table public.intake_drafts
  add column if not exists confirmed_garment_type text;
alter table public.intake_drafts
  add column if not exists confirmed_repair_category text;
alter table public.intake_drafts
  add column if not exists confirmed_repair_area text;
alter table public.intake_drafts
  add column if not exists confirmed_difficulty text;
alter table public.intake_drafts
  add column if not exists confirmed_price numeric(10,2);

-- ---------- Review state --------------------------------------------------
alter table public.intake_drafts
  add column if not exists review_status text default 'needs_review';
alter table public.intake_drafts
  add column if not exists reviewed_by text;
alter table public.intake_drafts
  add column if not exists reviewed_at timestamptz;

-- Queue page filters/sorts by review_status; a plain b-tree is sufficient.
create index if not exists intake_drafts_review_status_idx
  on public.intake_drafts (review_status);

-- ============================================================================
-- Verification:
--   select column_name from information_schema.columns
--    where table_name = 'intake_drafts'
--      and column_name in (
--        'ai_status','ai_garment_type','ai_repair_category','ai_repair_area',
--        'ai_difficulty','ai_suggested_price','ai_needs_human_review',
--        'confirmed_garment_type','confirmed_repair_category',
--        'confirmed_repair_area','confirmed_difficulty','confirmed_price',
--        'review_status','reviewed_by','reviewed_at'
--      );
--   -- expect 15 rows.
-- ============================================================================
