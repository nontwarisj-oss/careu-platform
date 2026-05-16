-- Store Ops Hardening — Phase A: multi-item repair intake.
--
-- Until now an order was ONE garment/item: the per-item fields lived
-- directly on public.orders (item_name, service_code, price, urgent…).
-- A real repair shop drops off several garments at once under one
-- ticket. This migration adds a child table so one order header can
-- carry many items.
--
-- ADDITIVE + BACKWARD-COMPATIBLE:
--   • public.orders is untouched — it stays the order HEADER (customer,
--     branch, job_id, status, grand total in `price`).
--   • Legacy single-item orders keep working: when an order has zero
--     order_items rows, the receipt/detail layer falls back to the
--     header's own item columns.
--   • New multi-item orders write one order_items row per garment; the
--     header `price` holds the summed grand total.
--
-- RLS: public.orders runs with RLS disabled (branch isolation is
-- enforced in the app layer). order_items matches that model for
-- consistency — see ROLLBACK note if RLS is later enabled platform-wide.
--
-- ROLLBACK
--   drop table if exists public.order_items;

create extension if not exists "pgcrypto";

create table if not exists public.order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  -- Denormalised branch slug so per-branch item queries (the Phase B
  -- operations board) never need to join orders.
  branch_id     text,
  -- 1-based position within the ticket, for stable display ordering.
  line_no       integer not null default 1,

  -- ---- What the customer dropped off --------------------------------
  category      text,
  service_code  text,
  service_name  text not null default '',
  detail        text,
  quantity      integer not null default 1,

  -- ---- Money (per line) ---------------------------------------------
  unit_price    numeric(12, 2) not null default 0,
  urgent        boolean        not null default false,
  urgent_fee    numeric(12, 2) not null default 0,
  -- quantity * unit_price + urgent_fee — stored so reports never recompute.
  line_total    numeric(12, 2) not null default 0,

  -- ---- Workflow ------------------------------------------------------
  due_date               date,
  assigned_technician_id uuid,
  technician_note        text,
  customer_note          text,

  -- ---- Attachments ---------------------------------------------------
  -- Array of Supabase Storage object paths for this item's photos.
  image_paths   jsonb not null default '[]'::jsonb,

  created_at    timestamptz not null default now()
);

create index if not exists order_items_order_id_idx
  on public.order_items (order_id);
create index if not exists order_items_branch_idx
  on public.order_items (branch_id);
create index if not exists order_items_due_date_idx
  on public.order_items (due_date) where due_date is not null;
create index if not exists order_items_technician_idx
  on public.order_items (assigned_technician_id)
  where assigned_technician_id is not null;

-- Mirror public.orders — app-layer branch isolation, no per-row RLS.
alter table public.order_items disable row level security;

-- ============================================================================
-- Verification:
--   insert into public.orders (customer_name, item_name, price)
--     values ('Test', 'multi', 0) returning id;          -- grab <id>
--   insert into public.order_items (order_id, service_name, unit_price,
--     quantity, line_total) values ('<id>', 'Hem pants', 80, 2, 160);
--   select count(*) from public.order_items where order_id = '<id>';  -- 1
-- ============================================================================
