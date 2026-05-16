-- Phase 27D — Franchise-safe public layer.
--
-- Five additive, nullable columns on public.branches — the operator-
-- managed public-facing fields behind /admin/settings/branches. No
-- rewrites, no backfill; existing rows read NULL and the public
-- pages fall back to safe defaults.
--
--   manual_status     text  — operator open/closed override:
--                             'open' | 'closed' | NULL (= 'auto',
--                             computed from operating_hours).
--   holiday_dates     jsonb — array of ISO dates the branch is shut,
--                             e.g. ["2026-12-31","2027-01-01"].
--   map_url           text  — explicit map link; when NULL the branch
--                             page derives a Google-Maps search URL
--                             from `address`.
--   line_url          text  — per-branch LINE link; when NULL the
--                             public NEXT_PUBLIC_LINE_OA_URL applies.
--   hero_image_path   text  — per-branch hero image for the branch
--                             page; when NULL the accent gradient
--                             shows alone.
--
-- branches is already anon-readable; these are public-DISPLAY fields
-- by design — no new RLS surface.
--
-- ROLLBACK
--   alter table public.branches
--     drop column if exists manual_status,
--     drop column if exists holiday_dates,
--     drop column if exists map_url,
--     drop column if exists line_url,
--     drop column if exists hero_image_path;

begin;

alter table public.branches
  add column if not exists manual_status   text
    check (manual_status in ('open','closed')),
  add column if not exists holiday_dates   jsonb not null default '[]'::jsonb,
  add column if not exists map_url         text,
  add column if not exists line_url        text,
  add column if not exists hero_image_path text;

commit;
