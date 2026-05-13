-- Smart order / quotation columns added on top of the intake-extension migration.
-- All columns are additive and nullable / defaulted so applying this is non-destructive.
-- Existing rows continue to work; new rows from /intake and /orders fill in the new fields.

alter table public.orders add column if not exists subtotal         numeric(12, 2);
alter table public.orders add column if not exists discount         numeric(12, 2) not null default 0;
alter table public.orders add column if not exists service_category text;
alter table public.orders add column if not exists service_code     text;
alter table public.orders add column if not exists service_name     text;
alter table public.orders add column if not exists quantity         integer not null default 1;
alter table public.orders add column if not exists template_text    text;
alter table public.orders add column if not exists customer_type    text;
alter table public.orders add column if not exists promotion_code   text;

create index if not exists orders_service_category_idx on public.orders (service_category);
create index if not exists orders_promotion_code_idx  on public.orders (promotion_code);
create index if not exists orders_customer_type_idx   on public.orders (customer_type);
