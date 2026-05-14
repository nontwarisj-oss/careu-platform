# CareU OPS Platform — Technician Payroll

> **Status:** permanent reference. The payroll UI ships in `/admin/payroll`; the schema dates back to `20260525_payroll_foundation.sql`. This doc is the spec for what the UI consumes and what HQ owes the technicians at month-end.

---

## 1. Why this exists

Care U + Ezy Repair pay each technician a **fixed daily wage** (the floor) plus owner-decided **bonus / deduction** at month-end. The platform's job is to:

1. Show what every technician's base wage looks like for the current month — derived from the KPI view, not entered by hand.
2. Surface productivity numbers (production value vs. target) so the owner can decide bonus / deduction with confidence.
3. Persist the decision as an immutable record once paid out.
4. Stay safe — finalize + paid statuses gate any further mutation.

No accounting export this phase. The numbers flow back into the existing `branch_monthly_profit` view via per-order `labor_cost`; this UI sits on top, computing what an owner *would* pay if they finalize today.

---

## 2. Schema (from `20260525`)

| Table | Purpose |
|---|---|
| `public.payroll_periods` | One row per (branch_id, year, month). Status: `open → finalized → paid` (or `cancelled`). |
| `public.technician_payroll_items` | One row per technician per period. Snapshots `daily_wage_snapshot` + `target_multiplier_snapshot` so historical pay-outs don't drift when HQ later raises a technician's wage. |
| `public.branch_monthly_profit` | View — `revenue − material − per-order labor − operational expenses`, per branch per month. Read separately from this UI. |

**RLS:**
- owner / hq_admin: full read+write on both tables.
- branch_manager: SELECT only, scoped to own `branch_id` via `current_user_branch_id()`.
- front_staff / technician: no policy → denied.

---

## 3. The formula

```
target_per_day = effectiveDailyTarget(tech)
               = productivity_target   when set
                 OR daily_wage × target_multiplier (default 3)
                 OR 0 when neither is configured

days_worked    = count of (technician_id, work_date) rows in
                 technician_daily_kpi for the month

base_wage      = daily_wage × days_worked
production     = sum of orders.production_value
               (falls back to price − material_cost where null)
target_value   = target_per_day × days_worked
performance    = production / target_value   (0 when no target)
final_pay      = base_wage + bonus − deduction
```

Three operator-visible insights derive from those numbers:

- **above target** flag — true when `production ≥ target_value`. Surfaced as a small green pill in the UI.
- **performance ratio** — rendered as `production / target` in the table; the owner reads it to decide bonus size.
- **production / target ratio at branch level** — summed across all technicians, shown in the summary band so HQ sees the branch's overall production health at a glance.

`lib/payrollService.ts::calculateEstimatedPayroll(tech, year, month)` returns every field above as `EstimatedPayroll`. The UI calls it on mount per technician and caches the result in component state. No write happens until the operator clicks "Save".

---

## 4. State machine

```
[open] ──── /api/admin/payroll/transition (to=finalized) ───→ [finalized]
   │                                                              │
   │                                                              │
   ▼                                                              ▼
edit items                                                edit items
freely                                                    (still allowed,
                                                          for after-finalize
                                                          bonus tweaks)
                                                                  │
                                                                  ▼
                          /api/admin/payroll/transition (to=paid) ─→ [paid]
                                                                  │
                                                                  ▼
                                                          items IMMUTABLE
                                                          (server rejects)
```

Transition rules enforced by `lib/payrollService.ts::transitionPeriod`:

- `to=finalized` accepts only when current status is `open`.
- `to=paid` accepts only when current status is `finalized`.
- Re-pressing the same transition is a no-op (idempotent).

`upsertPayrollItem` refuses to write when the period's status is `paid` — the operator must reopen the period via SQL if a correction is needed (deliberately friction-heavy; the design assumes paid-out is final).

---

## 5. UI walk-through

### `/admin/payroll` (owner / hq_admin)

1. **Filters band** — branch select, year (BE), month. Defaults: first branch, current BE year, current month.
2. **Period status row** — if no period exists for that (branch, year, month), shows "Open period" button. If one exists, shows status badge + finalize / mark-paid buttons gated by the state machine.
3. **Totals band** — five summary cards: tech count, total base wage, total final pay, production / target, overall ratio.
4. **Items table** — one row per active technician (incl. inactive techs who worked during the period). Editable bonus + deduction inputs; Save button per row.

**Branch manager view** — not built this phase. The RLS allows them to SELECT, but the page is `admin`-gated. A future read-only "Payroll preview" page for managers is a small addition; today HQ owns the workflow.

---

## 6. API surface

| Route | Body | Purpose |
|---|---|---|
| `POST /api/admin/payroll/open-period` | `{ branchId, year, month }` | Idempotent — returns existing period if present. |
| `POST /api/admin/payroll/save-item` | `{ payrollPeriodId, technicianProfileId, baseWage, daysWorked, productionValue, targetValue, performanceRatio, bonusAmount, deductionAmount, dailyWageSnapshot, targetMultiplierSnapshot, notes? }` | Upserts by `(payrollPeriodId, technicianProfileId)`. Recomputes `final_pay` server-side. |
| `POST /api/admin/payroll/transition` | `{ periodId, to: "finalized" \| "paid" }` | Validates the state-machine transition. |

All three require owner / hq_admin. Branch_manager can NOT call them.

---

## 7. Snapshot-on-save

`technician_payroll_items.daily_wage_snapshot` and `target_multiplier_snapshot` are populated from the technician's current wage at save time. This snapshot is the **only** record of what the wage was at month-end — HQ may later raise the wage and the historical pay-out won't drift.

The UI passes the snapshot values from `EstimatedPayroll.dailyWageSnapshot` / `targetMultiplierSnapshot` so the same number that produced the visible base-wage estimate is what gets stored.

---

## 8. Future enhancements (not this phase)

| Step | Why |
|---|---|
| Automatic bonus engine | Owner-decided today. A formula like `bonus = max(0, perf_ratio − 1) × base × bonus_rate` would speed up large payrolls. |
| Accounting export (CSV / Sheet) | Today there's no export. Plug into `branch_monthly_profit` for the bottom line. |
| Manager-facing read-only view | branch_manager has SELECT via RLS but no UI — small page that re-uses the same components. |
| Multi-month preview | Compare current month to last 3 months in one view. |
| Re-open paid period | Currently SQL-only. A guarded admin action with audit-log entry is the obvious next step. |
| Payroll cron pre-finalize | Auto-finalize at month-end (T+3 days) with a notification if owner hasn't reviewed. |

---

**Last updated:** 2026-05-14 (payroll UI + writes shipped)
