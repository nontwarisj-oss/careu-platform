-- BrandConfig DB mirror.
--
-- Until now, branch UI metadata (short label, logo, accent gradient, tagline,
-- address, phone, receipt name) lived only in lib/brandConfig.ts. The
-- branches table held just code / short_code / name / type / brand /
-- is_active. Onboarding a new branch through /admin/onboarding required a
-- code-side PR to mirror the row into brandConfig.ts — friction the wizard
-- couldn't eliminate.
--
-- This migration moves the UI metadata into public.branches as nullable
-- columns. lib/branchContext.tsx fetches from the DB at session start and
-- falls back to the hardcoded list in lib/brandConfig.ts when (a) a column
-- is null or (b) the DB read fails. The hardcoded list stays as the seed
-- + fallback so existing deploys keep rendering correctly while the new
-- columns are populated.
--
-- Rows for the two seeded branches are UPDATEd in this migration so the
-- mirror is correct out of the box. The wizard backfills any new branch's
-- columns at create time; existing branches with NULL columns continue to
-- use the brandConfig.ts fallback for the missing fields only.
--
-- ROLLBACK
--   alter table public.branches
--     drop column if exists short_label,
--     drop column if exists short_name,
--     drop column if exists receipt_name,
--     drop column if exists tagline,
--     drop column if exists address,
--     drop column if exists phone,
--     drop column if exists logo_path,
--     drop column if exists accent_class;

-- ---------- 1. UI-metadata columns ----------------------------------------

alter table public.branches add column if not exists short_label  text;
alter table public.branches add column if not exists short_name   text;
alter table public.branches add column if not exists receipt_name text;
alter table public.branches add column if not exists tagline      text;
alter table public.branches add column if not exists address      text;
alter table public.branches add column if not exists phone        text;
alter table public.branches add column if not exists logo_path    text;
alter table public.branches add column if not exists accent_class text;

comment on column public.branches.short_label  is 'Selector / chip label, e.g. "C24 Care U - 001"';
comment on column public.branches.short_name   is 'Sidebar header label, e.g. "C24 Care U"';
comment on column public.branches.receipt_name is 'Receipt header, e.g. "C24 Care U"';
comment on column public.branches.tagline      is 'Receipt tagline (Thai)';
comment on column public.branches.address      is 'Storefront address (free text)';
comment on column public.branches.phone        is 'Storefront phone (free text or "N/A")';
comment on column public.branches.logo_path    is 'Public path to the branch logo SVG/PNG';
comment on column public.branches.accent_class is 'Tailwind gradient classes for branch accent';

-- ---------- 2. Backfill the seed rows -------------------------------------
-- Mirrors lib/brandConfig.ts exactly so the DB is the source of truth for
-- the two seeded branches as soon as this migration is applied.

update public.branches set
  short_label  = coalesce(short_label,  'C24 Care U - 001'),
  short_name   = coalesce(short_name,   'C24 Care U'),
  receipt_name = coalesce(receipt_name, 'C24 Care U'),
  tagline      = coalesce(tagline,      'แคร์ยู ดูแลเสื้อผ้าคุณด้วยใจ'),
  address      = coalesce(address,      'ตลาดสดธนบุรี'),
  phone        = coalesce(phone,        'N/A'),
  logo_path    = coalesce(logo_path,    '/logos/c24-careu.svg'),
  accent_class = coalesce(accent_class, 'from-green-700 to-emerald-600')
where code = 'c24-thonburi-market';

update public.branches set
  short_label  = coalesce(short_label,  'Ezy Repair - 001'),
  short_name   = coalesce(short_name,   'Ezy Repair'),
  receipt_name = coalesce(receipt_name, 'Ezy Repair by Care U'),
  tagline      = coalesce(tagline,      'ซ่อมไว ได้ดั่งใจ แค่ทักไลน์'),
  address      = coalesce(address,      'BTS ศาลาแดง'),
  phone        = coalesce(phone,        'N/A'),
  logo_path    = coalesce(logo_path,    '/logos/ezy-repair.svg'),
  accent_class = coalesce(accent_class, 'from-green-800 to-lime-700')
where code = 'ezy-repair-saladaeng';

-- ============================================================================
-- Verification queries:
--
--   select code, short_label, short_name, receipt_name, accent_class
--     from public.branches order by code;
--   -- expect 2 rows for the seeded branches with non-null UI metadata.
--
-- ============================================================================
