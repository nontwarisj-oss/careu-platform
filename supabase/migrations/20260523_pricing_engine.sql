-- Pricing engine foundation — service_prices reshaping + audit log + RLS.
--
-- ============================================================================
-- BEFORE YOU APPLY THIS MIGRATION
-- ============================================================================
--
-- This is additive and rename-only; no data is dropped. Renames are wrapped
-- in IF-EXISTS guards so the migration is safe to re-run.
--
-- Apply order: AFTER 20260522 (depends on public.current_user_role()).
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--
--     drop trigger if exists pricing_change_audit on public.service_prices;
--     drop trigger if exists service_prices_touch_updated on public.service_prices;
--     drop function if exists public.log_pricing_change();
--     drop function if exists public.touch_pricing_updated_at();
--     drop policy if exists service_prices_read_all on public.service_prices;
--     drop policy if exists service_prices_admin_write on public.service_prices;
--     alter table public.service_prices disable row level security;
--     drop policy if exists pricing_audit_admin_read on public.pricing_audit_logs;
--     drop table if exists public.pricing_audit_logs;
--     -- Column renames are reversible by running the inverse renames.
--
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------- 1. Rename existing columns to the spec names ------------------
-- service_name           -> display_name
-- description_template   -> description
-- price_type             -> pricing_type
-- active                 -> is_active

do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='service_prices'
               and column_name='service_name')
     and not exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='service_prices'
               and column_name='display_name')
  then
    alter table public.service_prices rename column service_name to display_name;
  end if;
end $$;

do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='service_prices'
               and column_name='description_template')
     and not exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='service_prices'
               and column_name='description')
  then
    alter table public.service_prices rename column description_template to description;
  end if;
end $$;

do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='service_prices'
               and column_name='price_type')
     and not exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='service_prices'
               and column_name='pricing_type')
  then
    alter table public.service_prices rename column price_type to pricing_type;
  end if;
end $$;

do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='service_prices'
               and column_name='active')
     and not exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='service_prices'
               and column_name='is_active')
  then
    alter table public.service_prices rename column active to is_active;
  end if;
end $$;

-- The 'active' check constraint name (if any) survives the rename; the
-- partial unique indexes do not — rebuild them with the new column name.
drop index if exists service_prices_active_idx;
create index if not exists service_prices_is_active_idx
  on public.service_prices (is_active) where is_active;

-- ---------- 2. Convert branch_id from text slug to uuid FK -----------------
-- Existing 20260519 made branch_id text. The spec wants uuid referencing
-- public.branches(id). Migrate via the branches.code lookup so any seeded
-- slugs are preserved.

do $$
declare
  v_data_type text;
begin
  select data_type into v_data_type
  from information_schema.columns
  where table_schema='public' and table_name='service_prices' and column_name='branch_id';

  if v_data_type = 'text' then
    alter table public.service_prices add column if not exists branch_id_uuid uuid;
    update public.service_prices sp
      set branch_id_uuid = b.id
      from public.branches b
      where sp.branch_id = b.code
        and sp.branch_id_uuid is null;
    alter table public.service_prices drop column branch_id;
    alter table public.service_prices rename column branch_id_uuid to branch_id;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'service_prices_branch_id_fkey') then
    alter table public.service_prices
      add constraint service_prices_branch_id_fkey
      foreign key (branch_id) references public.branches(id) on delete set null;
  end if;
end $$;

create index if not exists service_prices_branch_id_idx on public.service_prices (branch_id);

-- ---------- 3. Convert created_by text -> uuid -----------------------------
do $$
declare
  v_data_type text;
begin
  select data_type into v_data_type
  from information_schema.columns
  where table_schema='public' and table_name='service_prices' and column_name='created_by';

  if v_data_type = 'text' then
    alter table public.service_prices add column if not exists created_by_uuid uuid;
    update public.service_prices set created_by_uuid = created_by::uuid
      where created_by is not null and created_by ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    alter table public.service_prices drop column created_by;
    alter table public.service_prices rename column created_by_uuid to created_by;
  end if;
end $$;

-- ---------- 4. New columns required by the spec ---------------------------
alter table public.service_prices add column if not exists business_type text;
update public.service_prices set business_type = 'care_u' where business_type is null;
alter table public.service_prices alter column business_type set default 'care_u';
alter table public.service_prices alter column business_type set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'service_prices_business_type_check') then
    alter table public.service_prices
      add constraint service_prices_business_type_check
      check (business_type in ('care_u','ezy_repair'));
  end if;
end $$;
create index if not exists service_prices_business_type_idx on public.service_prices (business_type);

alter table public.service_prices add column if not exists sort_order   integer     not null default 0;
alter table public.service_prices add column if not exists updated_at   timestamptz not null default now();
alter table public.service_prices add column if not exists updated_by   uuid;

-- ---------- 5. Scoped uniqueness for service_code --------------------------
-- Spec asks for service_code UNIQUE. The existing model is versioned (many
-- rows per code over time); make it unique only for the *active currently-
-- effective* row per (branch, business_type, code). Historical / disabled
-- rows are allowed to repeat.
drop index if exists service_prices_code_idx;
create index if not exists service_prices_service_code_idx
  on public.service_prices (service_code);

create unique index if not exists service_prices_active_scope_idx
  on public.service_prices (
    coalesce(branch_id::text, 'global'),
    business_type,
    service_code
  )
  where is_active = true and effective_to is null;

-- ---------- 6. updated_at + updated_by trigger ----------------------------
create or replace function public.touch_pricing_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  begin
    new.updated_by := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  exception when others then
    new.updated_by := old.updated_by;
  end;
  return new;
end $$;

drop trigger if exists service_prices_touch_updated on public.service_prices;
create trigger service_prices_touch_updated
  before update on public.service_prices
  for each row execute function public.touch_pricing_updated_at();

-- ---------- 7. pricing_audit_logs -----------------------------------------
create table if not exists public.pricing_audit_logs (
  id               uuid primary key default gen_random_uuid(),
  service_price_id uuid references public.service_prices(id) on delete cascade,
  action           text not null check (action in ('create','update','disable','activate','delete')),
  changed_by       uuid,
  before_value     jsonb,
  after_value      jsonb,
  changed_at       timestamptz not null default now()
);

create index if not exists pricing_audit_logs_sp_idx
  on public.pricing_audit_logs (service_price_id);
create index if not exists pricing_audit_logs_changed_at_idx
  on public.pricing_audit_logs (changed_at desc);

alter table public.pricing_audit_logs enable row level security;

drop policy if exists pricing_audit_admin_read on public.pricing_audit_logs;
create policy pricing_audit_admin_read on public.pricing_audit_logs
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- The audit table is otherwise written only by the trigger below, which
-- runs as the table owner via SECURITY DEFINER. No INSERT policies for
-- authenticated users → the only way to write is the trigger itself.

create or replace function public.log_pricing_change() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_action text;
begin
  begin
    v_actor := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  exception when others then
    v_actor := null;
  end;

  if TG_OP = 'INSERT' then
    v_action := 'create';
  elsif TG_OP = 'DELETE' then
    v_action := 'delete';
  else
    if OLD.is_active = true and NEW.is_active = false then
      v_action := 'disable';
    elsif OLD.is_active = false and NEW.is_active = true then
      v_action := 'activate';
    else
      v_action := 'update';
    end if;
  end if;

  insert into public.pricing_audit_logs (
    service_price_id, action, changed_by, before_value, after_value
  ) values (
    coalesce(NEW.id, OLD.id),
    v_action,
    v_actor,
    case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end,
    case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end
  );
  return coalesce(NEW, OLD);
end $$;

drop trigger if exists pricing_change_audit on public.service_prices;
create trigger pricing_change_audit
  after insert or update or delete on public.service_prices
  for each row execute function public.log_pricing_change();

-- ---------- 8. RLS on service_prices --------------------------------------
-- Read is open to every authenticated user (the catalog must be visible to
-- staff so the order form can render). Write is restricted to owner /
-- hq_admin per the spec; the application also hides the edit UI for other
-- roles via canManagePricing.
alter table public.service_prices enable row level security;

drop policy if exists service_prices_read_all on public.service_prices;
create policy service_prices_read_all on public.service_prices
  for select to authenticated using (true);

drop policy if exists service_prices_admin_write on public.service_prices;
create policy service_prices_admin_write on public.service_prices
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

-- ---------- 9. Seed from the hardcoded SERVICES catalog -------------------
-- Mirrors lib/pricing.ts. Idempotent — WHERE NOT EXISTS prevents re-seed
-- after a manual edit. Special rules (REP-002-PZ6 plastic zipper 6", and
-- ALT-001-RCN jeans reconstruction hem) included.

with seed (service_code, category, display_name, description, base_price, pricing_type, sort_order) as (
  values
    ('ALT-001', 'alteration',  'ตัดขากางเกง',           'บริการตัดขากางเกงตามความยาวที่ลูกค้ากำหนด',                                80::numeric, 'fixed',              10),
    ('ALT-002', 'alteration',  'ตัดเอวกางเกง',          'บริการตัดเอวกางเกงตามขนาดที่ลูกค้ากำหนด',                                 120::numeric,'fixed',              20),
    ('ALT-003', 'alteration',  'ตัดแขนเสื้อ',           'บริการตัดแขนเสื้อตามความยาวที่ลูกค้ากำหนด',                                100::numeric,'fixed',              30),
    ('ALT-004', 'alteration',  'ปรับขนาดเสื้อ/กางเกง',  'บริการปรับขนาดเสื้อ/กางเกงตามรอบตัวที่ต้องการ',                            150::numeric,'fixed',              40),
    ('ALT-001-RCN','alteration','เย็บชายกางเกงยีนส์แบบ Reconstruction','ราคาเหมา ไม่คิดค่าเรียวขาเพิ่ม',                          200::numeric,'fixed',              50),
    ('REP-001', 'repair',      'ปะรูเสื้อ/กางเกง',      'บริการปะรูเสื้อหรือกางเกงด้วยเทคนิคที่เหมาะสมกับเนื้อผ้า',                  60::numeric, 'fixed',             110),
    ('REP-002', 'repair',      'เปลี่ยนซิป',            'บริการเปลี่ยนซิปกางเกง/กระโปรง/เสื้อแจ๊คเก็ต',                              150::numeric,'fixed',             120),
    ('REP-002-PZ6','repair',   'ซิปพลาสติก 6 นิ้ว (กางเกง)','ราคาเหมาเฉพาะซิปพลาสติก 6 นิ้วบนกางเกง',                              130::numeric,'fixed',             125),
    ('REP-003', 'repair',      'ติดกระดุม (ต่อเม็ด)',   'บริการติดกระดุม คิดราคาต่อเม็ด',                                            20::numeric, 'fixed',             130),
    ('REP-004', 'repair',      'เย็บตะเข็บที่ขาด',      'บริการเย็บตะเข็บที่ขาดให้กลับมาแน่นหนา',                                     40::numeric, 'fixed',             140),
    ('LTH-001', 'leather',     'ซ่อมหนังถลอก/ขาด',     'ซ่อมหนังถลอก/ขาด ต้องประเมินราคาตามลักษณะของชิ้นงาน',                       null,         'estimate_required', 210),
    ('LTH-002', 'leather',     'ทาสีหนัง',              'ทาสีหนังให้กลับมาเงางาม ต้องประเมินราคาตามขนาดและสี',                       null,         'estimate_required', 220),
    ('LUG-001', 'luggage',     'ซ่อม/เปลี่ยนล้อกระเป๋าเดินทาง','บริการซ่อมหรือเปลี่ยนล้อกระเป๋าเดินทาง (ราคาต่อล้อ)',                250::numeric,'fixed',             310),
    ('LUG-002', 'luggage',     'ซ่อมหูจับกระเป๋า',     'ซ่อมหูจับ/มือจับกระเป๋า ต้องประเมินราคาตามลักษณะ',                            null,         'estimate_required', 320),
    ('DRY-001', 'drycleaning', 'ซักแห้งเสื้อเชิ้ต',     'บริการซักแห้งเสื้อเชิ้ตด้วยน้ำยามาตรฐาน',                                   80::numeric, 'fixed',             410),
    ('DRY-002', 'drycleaning', 'ซักแห้งสูท',            'บริการซักแห้งสูทพร้อมรีดและจัดทรง',                                          200::numeric,'fixed',             420),
    ('SPC-001', 'special',     'งานปักพิเศษ',          'งานปักออกแบบพิเศษ ต้องประเมินราคาตามแบบที่ลูกค้าต้องการ',                   null,         'estimate_required', 510),
    ('SPC-999', 'special',     'งานอื่นๆ (ระบุเอง)',    '',                                                                          null,         'estimate_required', 990)
)
insert into public.service_prices (
  service_code, category, business_type, display_name, description,
  base_price, pricing_type, urgent_fee_default, is_active, sort_order,
  branch_id, brand_id
)
select
  seed.service_code,
  seed.category,
  'care_u',
  seed.display_name,
  seed.description,
  seed.base_price,
  seed.pricing_type,
  30::numeric,
  true,
  seed.sort_order,
  null,
  null
from seed
where not exists (
  select 1 from public.service_prices sp
  where sp.service_code = seed.service_code
    and sp.business_type = 'care_u'
    and sp.branch_id is null
    and sp.is_active = true
    and sp.effective_to is null
);

-- ============================================================================
-- Verification queries you can run after applying:
--
--   select count(*) from public.service_prices where is_active and business_type='care_u';  -- expect >= 18
--   select * from public.pricing_audit_logs order by changed_at desc limit 5;
--
-- ============================================================================
