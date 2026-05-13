-- Operational hardening — data integrity, validation, audit, recovery.
--
-- ============================================================================
-- BEFORE YOU APPLY THIS MIGRATION
-- ============================================================================
--
-- Apply order: AFTER 20260525. Depends on:
--   • public.orders + assigned_technician_id + branch_id + status         (20260512..20260524)
--   • public.technician_profiles                                          (20260524)
--   • public.profiles + public.branches                                   (20260521)
--   • public.expenses                                                     (20260518 + 20260525)
--   • public.order_audit_log + public.pricing_audit_logs                  (20260520, 20260523)
--   • public.current_user_role()                                          (20260522)
--
-- Additive + idempotent. Every CHECK constraint we add is `NOT VALID` so
-- existing rows are NOT re-checked — only future INSERT/UPDATE writes
-- must satisfy the new contract. This is the safest pattern for a live
-- production system with pre-existing data.
--
-- ============================================================================
-- WHAT THIS MIGRATION SHIPS
-- ============================================================================
--
--   • public.sync_failures       — durable queue for failed exports
--   • public.expense_audit_log   — append-only audit for expense changes
--   • Extended order_audit_log.action enum: + assigned + receipt_regenerated
--                                            + sync_failed
--   • orders.status CHECK         (pending | in-progress | completed |
--                                  ready-for-pickup | cancelled)
--   • orders.payment_status CHECK (unpaid | deposit | paid)
--   • orders.quantity / urgent_fee / discount / price >= 0 CHECKs
--   • public.validate_order_assignment() — trigger fn that rejects
--     inactive-tech and cross-branch assignment
--   • Search indexes: orders.customer_name, orders(branch_id, status,
--     created_at desc), pg_trgm GIN on customers.name + .normalized_name
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--
--   drop trigger if exists orders_validate_assignment on public.orders;
--   drop function if exists public.validate_order_assignment();
--   drop trigger if exists expense_change_audit on public.expenses;
--   drop function if exists public.log_expense_change();
--   drop policy if exists expense_audit_admin_read on public.expense_audit_log;
--   drop table if exists public.expense_audit_log;
--   drop policy if exists sync_failures_admin_read on public.sync_failures;
--   drop table if exists public.sync_failures;
--   alter table public.orders drop constraint if exists orders_status_check;
--   alter table public.orders drop constraint if exists orders_payment_status_check;
--   alter table public.orders drop constraint if exists orders_quantity_check;
--   alter table public.orders drop constraint if exists orders_price_nonneg;
--   alter table public.orders drop constraint if exists orders_urgent_fee_nonneg;
--   alter table public.orders drop constraint if exists orders_discount_nonneg;
--   alter table public.order_audit_log drop constraint if exists order_audit_log_action_check;
--   alter table public.order_audit_log add constraint order_audit_log_action_check
--     check (action in ('created','status_changed','payment_changed',
--                       'cost_updated','cancelled','sync_pushed'));
--   drop index if exists orders_customer_name_idx;
--   drop index if exists orders_branch_status_recent_idx;
--   drop index if exists customers_name_trgm_idx;
--
-- ============================================================================

create extension if not exists "pgcrypto";

-- pg_trgm enables ILIKE / similarity search via GIN indexes. The extension
-- is on Supabase by default; create-if-not-exists is safe.
create extension if not exists "pg_trgm";

-- ---------- 1. orders status + payment_status standardisation -------------
-- NOT VALID = don't re-check existing rows, only enforce on new writes.
-- If an existing row already has an unknown status, we ignore it and let
-- staff correct it via the orders UI.

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_status_check') then
    alter table public.orders
      add constraint orders_status_check
      check (status in (
        'pending','in-progress','completed','ready-for-pickup','cancelled'
      )) not valid;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_payment_status_check') then
    alter table public.orders
      add constraint orders_payment_status_check
      check (payment_status in ('unpaid','deposit','paid')) not valid;
  end if;
end $$;

-- ---------- 2. orders numeric non-negative constraints --------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_quantity_check') then
    alter table public.orders
      add constraint orders_quantity_check
      check (quantity is null or quantity >= 1) not valid;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_price_nonneg') then
    alter table public.orders
      add constraint orders_price_nonneg
      check (price >= 0) not valid;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_urgent_fee_nonneg') then
    alter table public.orders
      add constraint orders_urgent_fee_nonneg
      check (urgent_fee is null or urgent_fee >= 0) not valid;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_discount_nonneg') then
    alter table public.orders
      add constraint orders_discount_nonneg
      check (discount is null or discount >= 0) not valid;
  end if;
end $$;

-- ---------- 3. Extend order_audit_log action enum -------------------------
alter table public.order_audit_log drop constraint if exists order_audit_log_action_check;
alter table public.order_audit_log
  add constraint order_audit_log_action_check
  check (action in (
    'created',
    'status_changed',
    'payment_changed',
    'cost_updated',
    'cancelled',
    'sync_pushed',
    'assigned',
    'receipt_regenerated',
    'sync_failed'
  ));

-- ---------- 4. Validate assignment trigger --------------------------------
-- Rejects:
--   • Assigning a non-existent technician
--   • Assigning an inactive technician
--   • Cross-branch assignment (technician's branch != order's branch)
--
-- Fires only when assigned_technician_id is being set to a non-null value;
-- clearing the assignment is always allowed.

create or replace function public.validate_order_assignment() returns trigger
language plpgsql
as $$
declare
  v_tech_active     boolean;
  v_tech_branch_id  uuid;
  v_tech_branch_code text;
begin
  if new.assigned_technician_id is null then
    return new;
  end if;

  select tp.active, tp.branch_id
    into v_tech_active, v_tech_branch_id
  from public.technician_profiles tp
  where tp.id = new.assigned_technician_id;

  if not found then
    raise exception 'Assigned technician % does not exist',
      new.assigned_technician_id;
  end if;
  if v_tech_active = false then
    raise exception 'Cannot assign inactive technician %',
      new.assigned_technician_id
      using errcode = 'check_violation';
  end if;

  -- Cross-branch check. profiles store branch_id as uuid; orders store text
  -- branch_code, so we resolve via branches.code.
  if v_tech_branch_id is not null and new.branch_id is not null then
    select b.code into v_tech_branch_code
    from public.branches b
    where b.id = v_tech_branch_id;
    if v_tech_branch_code is not null
       and v_tech_branch_code <> new.branch_id then
      raise exception
        'Cross-branch assignment forbidden: technician belongs to "%", order belongs to "%"',
        v_tech_branch_code, new.branch_id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists orders_validate_assignment on public.orders;
create trigger orders_validate_assignment
  before insert or update of assigned_technician_id, branch_id on public.orders
  for each row execute function public.validate_order_assignment();

-- ---------- 5. sync_failures (durable retry queue) ------------------------
-- Today the queue has no consumer — entries accumulate and admins can read
-- them at /admin/sync. The retry worker is next phase; the table shape is
-- stable so the worker just adds a status='retrying' loop.

create table if not exists public.sync_failures (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in (
                    'order_to_sheet',
                    'pricing_to_sheet',
                    'debug_to_sheet',
                    'customer_from_sheet',
                    'expense_from_sheet'
                  )),
  /** Logical target identifier — order uuid / service_code / etc. */
  target_id       text,
  /** Free-form context useful for a future retry job. */
  payload         jsonb not null default '{}'::jsonb,
  reason          text not null,
  branch_id       text,
  attempts        integer not null default 0,
  status          text not null default 'pending'
                  check (status in ('pending','retrying','resolved','dead')),
  last_attempt_at timestamptz,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  created_by      uuid
);

create index if not exists sync_failures_kind_idx          on public.sync_failures (kind);
create index if not exists sync_failures_status_idx        on public.sync_failures (status);
create index if not exists sync_failures_target_idx        on public.sync_failures (target_id);
create index if not exists sync_failures_created_at_idx    on public.sync_failures (created_at desc);
create index if not exists sync_failures_branch_idx        on public.sync_failures (branch_id);

alter table public.sync_failures enable row level security;

drop policy if exists sync_failures_admin_read on public.sync_failures;
create policy sync_failures_admin_read on public.sync_failures
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- The application writes via the service-role client (lib/syncFailures.ts);
-- there is no INSERT policy for authenticated users so anon / branch_manager
-- / front_staff / technician cannot pollute the queue.

-- ---------- 6. expense_audit_log + trigger --------------------------------
-- Mirrors pricing_audit_logs from 20260523. Trigger-driven; no app code
-- can forget to log. Cost panel + expense form edits are both captured.

create table if not exists public.expense_audit_log (
  id           uuid primary key default gen_random_uuid(),
  expense_id   uuid references public.expenses(id) on delete cascade,
  action       text not null check (action in (
                 'create','update','delete'
               )),
  changed_by   uuid,
  before_value jsonb,
  after_value  jsonb,
  changed_at   timestamptz not null default now()
);

create index if not exists expense_audit_log_expense_idx
  on public.expense_audit_log (expense_id);
create index if not exists expense_audit_log_changed_at_idx
  on public.expense_audit_log (changed_at desc);

alter table public.expense_audit_log enable row level security;

drop policy if exists expense_audit_admin_read on public.expense_audit_log;
create policy expense_audit_admin_read on public.expense_audit_log
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- The trigger uses SECURITY DEFINER + locked search_path. Writes happen
-- under the table owner's privileges, so the lack of an INSERT policy on
-- expense_audit_log does NOT block the trigger.

create or replace function public.log_expense_change() returns trigger
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
    v_action := 'update';
  end if;

  insert into public.expense_audit_log (
    expense_id, action, changed_by, before_value, after_value
  ) values (
    coalesce(NEW.id, OLD.id),
    v_action,
    v_actor,
    case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end,
    case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end
  );
  return coalesce(NEW, OLD);
end $$;

drop trigger if exists expense_change_audit on public.expenses;
create trigger expense_change_audit
  after insert or update or delete on public.expenses
  for each row execute function public.log_expense_change();

-- ---------- 7. Search indexes --------------------------------------------
-- Today /orders search runs a JS ILIKE over the fetched array. As volume
-- grows the search will move server-side; these indexes prepare for that.

create index if not exists orders_customer_name_idx
  on public.orders (lower(customer_name));

create index if not exists orders_branch_status_recent_idx
  on public.orders (branch_id, status, created_at desc);

-- pg_trgm GIN on customers.name + normalized_name for fast fuzzy lookup.
-- This is what /customers search will eventually use server-side.
create index if not exists customers_name_trgm_idx
  on public.customers using gin (name gin_trgm_ops);

create index if not exists customers_normalized_name_trgm_idx
  on public.customers using gin (normalized_name gin_trgm_ops);

-- ---------- 8. Verification queries ---------------------------------------
-- After applying:
--   select conname, contype, convalidated, pg_get_constraintdef(oid)
--     from pg_constraint
--     where conrelid = 'public.orders'::regclass and conname like 'orders_%check'
--     order by conname;
--   select count(*) from public.sync_failures;        -- expect 0
--   select count(*) from public.expense_audit_log;    -- count grows as edits happen
--   \d+ public.orders                                  -- shows the trigger
