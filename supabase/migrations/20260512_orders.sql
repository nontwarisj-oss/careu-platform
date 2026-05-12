
-- Orders table aligned with the frontend (app/orders/page.tsx, app/invoices/page.tsx).
-- One row per order line — price and item_name live on the order itself
-- (the app does not split orders into separate line-item records).

create extension if not exists "pgcrypto";

create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references public.customers(id) on delete set null,
  customer_name text not null,
  item_name     text not null,
  price         numeric(12, 2) not null default 0,
  status        text not null default 'pending',
  created_at    timestamptz not null default now()
);

create index if not exists orders_customer_id_idx on public.orders (customer_id);
create index if not exists orders_created_at_idx  on public.orders (created_at desc);

-- RLS explicitly disabled per product requirement.
-- TODO: re-enable and add policies once auth is wired in.
alter table public.orders disable row level security;
