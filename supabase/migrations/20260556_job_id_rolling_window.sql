-- Job ID reuse — 45-day rolling window.
--
-- Care U manual Job IDs should only collide if the same id was used
-- in the same branch within the last ~45 days. A Care U job normally
-- finishes well inside that window, so an id older than 45 days is
-- free to be reused.
--
-- A rolling 45-day window CANNOT be a database constraint: a partial
-- unique index predicate must be IMMUTABLE, so it cannot reference
-- now(). Any DB-level rule is therefore either "unique forever" or
-- not enforced at all.
--
-- Decision: Job ID uniqueness is enforced by APPLICATION LOGIC within
-- a 45-day rolling window — see app/api/orders/check-job-id/route.ts
-- and lib/orderCreate.ts (both scope the lookup by branch_id + job_id
-- AND created_at >= now() - 45 days).
--
-- NOTE: public.orders has NO business_type column, so neither the
-- lookup index nor the duplicate check keys on it — the duplicate
-- key is (branch_id, job_id) within the rolling window. care_u vs
-- ezy_repair is decided in app logic only (Ezy auto-generates its
-- Job ID and is never checked against the orders table).
--
-- The previous scoped-unique index (orders_job_id_scoped_idx) blocked
-- reuse forever, so it is dropped here and replaced with a plain,
-- non-unique lookup index that keeps the duplicate-check query fast.

drop index if exists orders_job_id_unique_idx;   -- legacy global-unique (already dropped in 20260521)
drop index if exists orders_job_id_scoped_idx;    -- scoped-unique — blocked 45-day reuse

create index if not exists orders_job_id_lookup_idx
  on public.orders (branch_id, job_id, created_at)
  where job_id is not null;
