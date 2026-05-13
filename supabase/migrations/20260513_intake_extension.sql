-- Optional extension migration for the mobile intake workflow.
-- Safe to run multiple times; all changes are additive and nullable.

create extension if not exists "pgcrypto";

-- Extra job fields used by /intake. Existing rows get nullable defaults so
-- nothing breaks if this migration is applied after data already exists.
alter table public.orders add column if not exists urgent      boolean        not null default false;
alter table public.orders add column if not exists urgent_fee  numeric(12, 2) not null default 0;
alter table public.orders add column if not exists notes       text;
alter table public.orders add column if not exists branch_id   text;

create index if not exists orders_branch_id_idx on public.orders (branch_id);

-- Media attachments for an order — photos / videos / intake docs.
-- file_url points at Supabase Storage once a bucket is provisioned;
-- file_type is a free-form mime hint ("image/jpeg", "video/mp4", "application/pdf").
create table if not exists public.order_attachments (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  file_url    text not null,
  file_type   text not null,
  file_name   text,
  created_at  timestamptz not null default now()
);

create index if not exists order_attachments_order_id_idx on public.order_attachments (order_id);

-- RLS intentionally disabled for now — matches the rest of the schema.
alter table public.order_attachments disable row level security;
