-- Expense_Log table — operational expenses across all branches.
-- Modelled on the Expense_Log Google Sheet so the future sync adapter can
-- write directly. Idempotent / additive.
--
-- NOTE: an earlier migration (20260516_rbac_finance.sql) created
-- public.branch_expenses as a placeholder. That table has never been used by
-- the application; the new public.expenses replaces it. Keep branch_expenses
-- in place for now (no drop) so this migration is non-destructive — a follow-
-- up clean-up migration can remove it once we are sure nothing references it.

create extension if not exists "pgcrypto";

create table if not exists public.expenses (
  id              uuid primary key default gen_random_uuid(),
  expense_date    date not null default current_date,
  category        text not null,
  description     text,
  amount          numeric(12, 2) not null default 0 check (amount >= 0),
  branch_id       text,
  payment_method  text,
  notes           text,
  created_by      text,
  created_at      timestamptz not null default now()
);

create index if not exists expenses_branch_id_idx on public.expenses (branch_id);
create index if not exists expenses_date_idx      on public.expenses (expense_date desc);
create index if not exists expenses_category_idx  on public.expenses (category);

alter table public.expenses disable row level security;
