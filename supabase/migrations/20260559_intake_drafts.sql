-- Phase 2.5 — Mobile Intake Draft Workflow.
--
-- Additive: two NEW tables only. Nothing existing is altered, so the
-- passed-UAT Core Flow, orders, documents, and Pricing Master are untouched.
--
-- Real-shop context: the front counter has no computer. Staff use a phone
-- (no login) to capture a customer's garments as an "intake draft" — a few
-- text fields + photos/video. The draft gets a short human Draft ID
-- (DYYMMDD-NNN) for the paper bag tag. Owner/Admin reviews the queue later
-- and turns a draft into a real order via the existing /intake flow.
--
-- Access model: both tables run with RLS ENABLED and NO policies — the only
-- way in is the service-role API routes (an anon/authenticated browser
-- client gets nothing). This keeps the surface tight and does not touch or
-- weaken any existing table's RLS.
--
-- Safe to re-run (CREATE … IF NOT EXISTS, idempotent indexes/trigger).

create extension if not exists "pgcrypto";

create table if not exists public.intake_drafts (
  id                        uuid primary key default gen_random_uuid(),
  draft_code                text not null unique,
  -- Text branch slug — matches public.orders.branch_id (the order flow a
  -- draft is later converted into), so conversion needs no translation.
  branch_id                 text,
  customer_name             text,
  customer_phone            text,
  staff_note                text,
  urgent_requested          boolean not null default false,
  status                    text not null default 'NEW',
  -- AI fields — placeholders for the future image/voice/video analyzer.
  ai_summary                text,
  ai_suggested_category     text,
  ai_suggested_service_code text,
  ai_confidence             numeric(5,2),
  admin_review_note         text,
  converted_order_id        uuid,
  created_by                uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create table if not exists public.intake_draft_media (
  id             uuid primary key default gen_random_uuid(),
  draft_id       uuid not null references public.intake_drafts(id) on delete cascade,
  media_type     text not null check (media_type in ('image','video','audio')),
  -- Storage object path inside the private customer-uploads bucket; the
  -- admin route signs a short-lived read URL for display.
  file_url       text not null,
  thumbnail_url  text,
  ai_description text,
  created_at     timestamptz not null default now()
);

create index if not exists intake_drafts_draft_code_idx on public.intake_drafts (draft_code);
create index if not exists intake_drafts_branch_id_idx  on public.intake_drafts (branch_id);
create index if not exists intake_drafts_status_idx     on public.intake_drafts (status);
create index if not exists intake_drafts_created_at_idx on public.intake_drafts (created_at desc);
create index if not exists intake_draft_media_draft_idx on public.intake_draft_media (draft_id);

-- updated_at touch trigger — same style as touch_service_price_master_updated_at.
create or replace function public.touch_intake_drafts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists intake_drafts_touch_updated on public.intake_drafts;
create trigger intake_drafts_touch_updated
  before update on public.intake_drafts
  for each row execute function public.touch_intake_drafts_updated_at();

-- RLS ON with NO policies → service-role API routes are the only access
-- path. The browser (anon / authenticated) can neither read nor write.
alter table public.intake_drafts enable row level security;
alter table public.intake_draft_media enable row level security;

-- ============================================================================
-- Verification:
--   select count(*) from public.intake_drafts;          -- 0 initially
--   \d public.intake_drafts                             -- columns present
-- ============================================================================
