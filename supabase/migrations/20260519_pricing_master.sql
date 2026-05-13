-- Pricing Master — versioned service catalog edited from /pricing.
-- Each row represents one *version* of a service's pricing. A service is
-- identified by service_code; the currently-effective version is the row
-- where active = true AND effective_to IS NULL AND effective_from <= now().
-- Older versions are kept for audit; the UI closes a version by setting
-- active=false and effective_to=now() before inserting the replacement.
--
-- branch_id / brand_id are optional scoping: NULL = applies to every
-- branch / brand. When two rows match the same service_code at the same
-- time (one global, one branch-specific), the more-specific row wins —
-- that resolution lives in lib/pricingDb.ts, not in the schema, so we
-- can iterate on the policy without a migration.
--
-- RLS is intentionally OFF to match the rest of the schema (auth lands in
-- a separate phase). Safe to re-run.

create extension if not exists "pgcrypto";

create table if not exists public.service_prices (
  id                   uuid primary key default gen_random_uuid(),
  service_code         text not null,
  category             text not null,
  service_name         text not null,
  description_template text,
  base_price           numeric(12, 2),
  price_type           text not null default 'fixed'
                       check (price_type in ('fixed', 'estimate_required')),
  urgent_fee_default   numeric(12, 2) not null default 0,
  active               boolean not null default true,
  branch_id            text,
  brand_id             text,
  effective_from       timestamptz not null default now(),
  effective_to         timestamptz,
  created_at           timestamptz not null default now(),
  created_by           text
);

create index if not exists service_prices_code_idx     on public.service_prices (service_code);
create index if not exists service_prices_category_idx on public.service_prices (category);
create index if not exists service_prices_active_idx   on public.service_prices (active) where active;
create index if not exists service_prices_effective_idx on public.service_prices (effective_from, effective_to);
create index if not exists service_prices_branch_idx   on public.service_prices (branch_id);
create index if not exists service_prices_brand_idx    on public.service_prices (brand_id);

alter table public.service_prices disable row level security;
