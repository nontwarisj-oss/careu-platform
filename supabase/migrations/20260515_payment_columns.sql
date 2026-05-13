-- Payment + document-type columns for the combined intake/quote/receipt workflow.
-- Idempotent and additive. Existing rows pick up the defaults.

alter table public.orders add column if not exists payment_status text not null default 'unpaid';
alter table public.orders add column if not exists payment_method text;
alter table public.orders add column if not exists document_type  text not null default 'intake_quote_receipt';

create index if not exists orders_payment_status_idx on public.orders (payment_status);
