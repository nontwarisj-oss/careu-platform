-- Pricing Master (Phase 2) — public.service_price_master
--
-- A NEW, standalone catalog table. It is intentionally SEPARATE from the
-- legacy public.service_prices (the versioned pricing-engine table from
-- 20260519 / 20260523, still used by /pricing + lib/pricingDb.ts). Phase 2
-- introduces a different model: exactly one row per service_code (UNIQUE),
-- a quote_mode (AUTO / GUIDED / MANUAL), min/max price bands, guided
-- questions, and a Google-Sheet sync surface. Keeping it a separate table
-- means the passed-UAT Core Flow and the old pricing engine are untouched.
--
-- Source of truth: this table. The Google Sheet tab "Service_Prices" is the
-- easy editing surface; an owner-only server route upserts sheet rows here.
--
-- Safe to re-run: CREATE … IF NOT EXISTS, idempotent indexes/trigger, and an
-- ON CONFLICT seed upsert.

create extension if not exists "pgcrypto";

create table if not exists public.service_price_master (
  id                    uuid primary key default gen_random_uuid(),
  active                boolean not null default true,
  service_code          text not null unique,
  brand                 text not null default 'CARE_U',
  branch_scope          text not null default 'ALL',
  category_th           text not null,
  subcategory_th        text,
  service_name_th       text not null,
  quote_mode            text not null
                        check (quote_mode in ('AUTO_QUOTE','GUIDED_QUOTE','MANUAL_QUOTE')),
  base_price            numeric(10,2),
  min_price             numeric(10,2),
  max_price             numeric(10,2),
  unit                  text not null default 'ตัว',
  default_qty           numeric(10,2) not null default 1,
  difficulty_level      text,
  material_group        text,
  urgent_allowed        boolean not null default true,
  urgent_fee_per_item   numeric(10,2) not null default 30,
  promo_eligible        boolean not null default true,
  requires_human_verify boolean not null default false,
  guide_questions       jsonb not null default '[]'::jsonb,
  customer_note_th      text,
  staff_note_th         text,
  sort_order            integer not null default 999,
  version               text not null default 'v1',
  source                text not null default 'GOOGLE_SHEET',
  source_row            integer,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  synced_at             timestamptz
);

-- service_code already carries a UNIQUE index; the rest support the common
-- catalog filters (active list, category drill-down, branch scope, mode).
create index if not exists service_price_master_service_code_idx
  on public.service_price_master (service_code);
create index if not exists service_price_master_active_idx
  on public.service_price_master (active) where active;
create index if not exists service_price_master_category_idx
  on public.service_price_master (category_th, subcategory_th);
create index if not exists service_price_master_branch_scope_idx
  on public.service_price_master (branch_scope);
create index if not exists service_price_master_quote_mode_idx
  on public.service_price_master (quote_mode);

-- updated_at touch trigger — mirrors the project's existing trigger style
-- (cf. touch_pricing_updated_at in 20260523). A dedicated function keeps
-- this table independent of the legacy pricing trigger.
create or replace function public.touch_service_price_master_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists service_price_master_touch_updated on public.service_price_master;
create trigger service_price_master_touch_updated
  before update on public.service_price_master
  for each row execute function public.touch_service_price_master_updated_at();

-- RLS: the catalog must be READ by the intake form and the Pricing Master
-- page, both of which use the browser client (anon when the app runs
-- cookieless). Reads are therefore open. There is deliberately NO write
-- policy — the only write path is the owner-only sync route, which uses
-- the service-role client and bypasses RLS. Staff can consume, not edit.
alter table public.service_price_master enable row level security;

drop policy if exists service_price_master_read_all on public.service_price_master;
create policy service_price_master_read_all on public.service_price_master
  for select to anon, authenticated using (true);

-- ---------- Seed — confirmed C24 v1 prices --------------------------------
-- Idempotent: ON CONFLICT (service_code) refreshes the catalog fields so a
-- re-run keeps the confirmed numbers correct. source/synced_at are left to
-- the conflict target's existing values so a later real Sheet sync owns them.
insert into public.service_price_master (
  active, service_code, brand, branch_scope, category_th, subcategory_th,
  service_name_th, quote_mode, base_price, min_price, max_price, unit,
  default_qty, difficulty_level, material_group, urgent_allowed,
  urgent_fee_per_item, promo_eligible, requires_human_verify,
  guide_questions, customer_note_th, staff_note_th, sort_order, version,
  source, synced_at
) values
  (
    true, 'C24-PANTS-ZIP-PLASTIC-6', 'CARE_U', 'C24', 'กางเกง', 'เปลี่ยนซิป',
    'เปลี่ยนซิปกางเกง ซิปพลาสติก 6 นิ้ว', 'AUTO_QUOTE',
    130, 130, 130, 'ตัว', 1, 'STANDARD', 'ผ้าธรรมดา',
    true, 30, true, false, '[]'::jsonb,
    'ราคานี้สำหรับซิปพลาสติก 6 นิ้ว',
    'ถ้าซิปโลหะ/ซิปยาวกว่า 6 นิ้วให้ประเมินใหม่',
    100, 'v1', 'SEED', now()
  ),
  (
    true, 'C24-JEANS-HEM-ORIGINAL', 'CARE_U', 'C24', 'กางเกง', 'ตัดขา',
    'ตัดต่อปลายขายีนส์', 'AUTO_QUOTE',
    200, 200, 200, 'ตัว', 1, 'STANDARD', 'ยีนส์',
    true, 30, true, false, '[]'::jsonb,
    null,
    'งานตัดต่อปลายขายีนส์ปกติ ราคา 200 บาท/ตัว ไม่บวก taper พื้นฐานเพิ่ม',
    110, 'v1', 'SEED', now()
  )
on conflict (service_code) do update set
  active                = excluded.active,
  brand                 = excluded.brand,
  branch_scope          = excluded.branch_scope,
  category_th           = excluded.category_th,
  subcategory_th        = excluded.subcategory_th,
  service_name_th       = excluded.service_name_th,
  quote_mode            = excluded.quote_mode,
  base_price            = excluded.base_price,
  min_price             = excluded.min_price,
  max_price             = excluded.max_price,
  unit                  = excluded.unit,
  default_qty           = excluded.default_qty,
  difficulty_level      = excluded.difficulty_level,
  material_group        = excluded.material_group,
  urgent_allowed        = excluded.urgent_allowed,
  urgent_fee_per_item   = excluded.urgent_fee_per_item,
  promo_eligible        = excluded.promo_eligible,
  requires_human_verify = excluded.requires_human_verify,
  guide_questions       = excluded.guide_questions,
  customer_note_th      = excluded.customer_note_th,
  staff_note_th         = excluded.staff_note_th,
  sort_order            = excluded.sort_order,
  version               = excluded.version;

-- ============================================================================
-- Verification queries (run after applying):
--   select count(*) from public.service_price_master;                  -- >= 2
--   select service_code, quote_mode, base_price
--     from public.service_price_master order by sort_order;
--   -- C24-PANTS-ZIP-PLASTIC-6 → 130 ; C24-JEANS-HEM-ORIGINAL → 200
-- ============================================================================
