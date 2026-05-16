-- Phase 27B — Public website maturity.
--
-- Four additive, nullable columns — no rewrites, no backfill, no
-- breaking change. Existing rows simply read NULL and the public
-- pages degrade gracefully.
--
--   public.branches
--     operating_hours  jsonb  — structured weekly hours, rendered on
--                               the branch page when present.
--                               Shape (all keys optional):
--                                 { "mon": "09:00-19:00", ...,
--                                   "note": "หยุดวันหยุดนักขัตฤกษ์" }
--     promo_banner     text   — a branch-specific promotion line shown
--                               on /branches/[code].
--
--   public.quote_requests
--     urgency               text — 'standard' | 'urgent' (from the
--                                   public quote wizard).
--     fulfilment_preference text — 'in_store' | 'pickup' | 'delivery'.
--
-- The Google-Maps CTA on a branch page is derived from the existing
-- `address` column — no map_url column needed.
--
-- ROLLBACK
--   alter table public.branches
--     drop column if exists operating_hours,
--     drop column if exists promo_banner;
--   alter table public.quote_requests
--     drop column if exists urgency,
--     drop column if exists fulfilment_preference;

begin;

alter table public.branches
  add column if not exists operating_hours jsonb,
  add column if not exists promo_banner    text;

alter table public.quote_requests
  add column if not exists urgency               text,
  add column if not exists fulfilment_preference text;

commit;
