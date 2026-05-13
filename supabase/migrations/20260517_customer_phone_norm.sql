-- Customer identity / dedup helper column.
-- Adds a normalized_phone column (canonical Thai 10-digit form, leading "0")
-- so dedup queries can use a single key instead of re-parsing phone strings
-- every time. The frontend still passes raw phone — the column is just a
-- query helper for sync, future merge UI and (later) RLS policies.
--
-- Safe to run multiple times; non-destructive. We deliberately do NOT add a
-- UNIQUE constraint yet because legacy data is known to contain duplicates;
-- the application-level dedup in lib/customerImport keeps new inserts safe
-- and a follow-up merge tool will collapse the existing duplicates.

alter table public.customers add column if not exists normalized_phone text;

-- Backfill the new column from the existing raw phone strings.
update public.customers
set normalized_phone = case
    when length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 13
         and left(regexp_replace(phone, '\D', '', 'g'), 4) = '0066'
      then '0' || substr(regexp_replace(phone, '\D', '', 'g'), 5)
    when length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 12
         and left(regexp_replace(phone, '\D', '', 'g'), 3) = '066'
      then '0' || substr(regexp_replace(phone, '\D', '', 'g'), 4)
    when length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 11
         and left(regexp_replace(phone, '\D', '', 'g'), 2) = '66'
      then '0' || substr(regexp_replace(phone, '\D', '', 'g'), 3)
    when length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 9
      then '0' || regexp_replace(phone, '\D', '', 'g')
    else regexp_replace(coalesce(phone, ''), '\D', '', 'g')
  end
where normalized_phone is null
   or normalized_phone = '';

create index if not exists customers_normalized_phone_idx
  on public.customers (normalized_phone);
