-- Store Ops Hardening — per-item operational tracking.
--
-- A multi-item ticket often has each garment at a different stage: one
-- shirt ready, one waiting for a zipper, one still in progress. This
-- adds a per-item status so the shop can track each garment, not just
-- the whole order.
--
-- ADDITIVE: one nullable-safe column with a default. order_items rows
-- created before this migration (and any insert that omits the column)
-- get 'pending'. The order header's own status is unchanged — it stays
-- the ticket-level rollup the operations board shows.
--
-- The status vocabulary is the SAME free-text set the order header uses
-- (lib/statusBadges.ts): pending / in-progress / waiting_parts /
-- outsource / completed / ready-for-pickup / delivered / cancelled.
-- No enum — consistent with public.orders.status.
--
-- ROLLBACK
--   alter table public.order_items drop column if exists status;

alter table public.order_items
  add column if not exists status text not null default 'pending';

create index if not exists order_items_status_idx
  on public.order_items (status);

-- ============================================================================
-- Verification:
--   select status, count(*) from public.order_items group by status;
-- ============================================================================
