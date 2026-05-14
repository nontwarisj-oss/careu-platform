-- Recovery foundation. Two tiny operational adjustments to make the
-- /admin/recovery UI work cleanly:
--
--   1. Extend sync_failures.kind so LINE push failures get their own kind
--      instead of being mis-tagged as 'order_to_sheet' (Bug #6 from the
--      operational testing phase). Future retry workers can then filter
--      by kind without misrouting.
--   2. Add a branch_manager-scoped read policy on sync_failures so a
--      manager can see only their branch's failures in the recovery UI.
--      Owner / hq_admin already see everything via sync_failures_admin_read.
--
-- Both changes are idempotent. No data backfill: existing rows tagged
-- 'order_to_sheet' that were actually LINE failures stay where they are —
-- they remain readable, just under the old kind. The orchestrator
-- (lib/lineDelivery.ts) starts writing the new kind from this migration on.
--
-- ROLLBACK
--   alter table public.sync_failures drop constraint if exists sync_failures_kind_check;
--   alter table public.sync_failures add constraint sync_failures_kind_check
--     check (kind in (
--       'order_to_sheet','pricing_to_sheet','debug_to_sheet',
--       'customer_from_sheet','expense_from_sheet'
--     ));
--   drop policy if exists sync_failures_branch_read on public.sync_failures;

create extension if not exists "pgcrypto";

-- ---------- 1. Extend sync_failures.kind ----------------------------------
do $$
declare
  has_old_check boolean;
begin
  select exists (
    select 1
    from pg_constraint
    where conname = 'sync_failures_kind_check'
      and conrelid = 'public.sync_failures'::regclass
  ) into has_old_check;

  if has_old_check then
    alter table public.sync_failures drop constraint sync_failures_kind_check;
  end if;
end $$;

alter table public.sync_failures
  add constraint sync_failures_kind_check
  check (kind in (
    'order_to_sheet',
    'pricing_to_sheet',
    'debug_to_sheet',
    'customer_from_sheet',
    'expense_from_sheet',
    'line_send',
    'receipt_rebuild'
  ));

-- ---------- 2. Branch-scoped read for managers ----------------------------
-- sync_failures_admin_read (from 20260526) still covers owner / hq_admin.
-- This adds the manager view that the new /admin/recovery UI relies on.

drop policy if exists sync_failures_branch_read on public.sync_failures;
create policy sync_failures_branch_read on public.sync_failures
  for select to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and branch_id is not null
    and branch_id = public.current_user_branch_code()
  );

-- ============================================================================
-- Verification queries:
--
--   select kind, count(*) from public.sync_failures group by kind;
--   select policyname from pg_policies
--     where schemaname='public' and tablename='sync_failures';
--   -- expected: sync_failures_admin_read, sync_failures_branch_read
--
-- ============================================================================
