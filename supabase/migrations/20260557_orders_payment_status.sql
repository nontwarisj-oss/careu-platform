-- orders.payment_status — restore the missing column.
--
-- The operations board (/orders) and createSmartOrder both reference
-- orders.payment_status, but the column is absent on production:
-- "column orders.payment_status does not exist" breaks the board
-- query entirely. Add it idempotently with a safe default so both
-- existing rows and the board query work.
--
-- 'unpaid' is the same default createSmartOrder writes for new orders.

alter table public.orders
  add column if not exists payment_status text default 'unpaid';

update public.orders
  set payment_status = 'unpaid'
  where payment_status is null;
