-- Bonus engine audit columns.
--
-- The bonus engine ([`lib/bonusEngine.ts`](../lib/bonusEngine.ts)) suggests a
-- bonus from the technician's performance ratio. The owner can override
-- the suggestion before saving — we want both numbers on the row so a
-- future audit ("did the owner deviate from the formula?") is one query.
--
-- ROLLBACK
--   alter table public.technician_payroll_items
--     drop column if exists bonus_suggested,
--     drop column if exists bonus_rule_version;

alter table public.technician_payroll_items
  add column if not exists bonus_suggested  numeric(12, 2);
alter table public.technician_payroll_items
  add column if not exists bonus_rule_version text;

comment on column public.technician_payroll_items.bonus_suggested is
  'Auto-computed bonus from lib/bonusEngine.ts at save time. NULL when no rule was applied.';
comment on column public.technician_payroll_items.bonus_rule_version is
  'Identifier of the bonus rule version used to compute bonus_suggested.';
