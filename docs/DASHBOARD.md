# CareU OPS Platform — Dashboard Architecture

> **Status:** permanent reference. The dashboard has a three-layer separation (data fetch → KPI compute → role components) with a matview-backed summary as the scaling seam.

---

## 1. Layer overview

```
┌─────────────────────────────────────────────────────────────┐
│  app/page.tsx                                               │
│    • Picks the role-specific view (5 components)            │
│    • Calls fetchDashboardSnapshot + fetchSnapshotSummary    │
│      in parallel                                            │
│    • Passes orders/expenses arrays to operational widgets   │
│    • Surfaces snapshot freshness indicator in the header    │
└──────────────┬──────────────────────────────────────────────┘
               │
   ┌───────────┴──────────────┐
   ▼                          ▼
fetchDashboardSnapshot   fetchSnapshotSummary (via /api)
(live arrays for         (matview aggregates with
 per-row widgets)         live fallback)
```

---

## 2. Two data paths

### 2.1 Live operational read (`lib/dashboardData.ts`)

Returns `orders[]` + `expenses[]` + `customerCount` — the per-row arrays the role-specific dashboards consume for queues, lists, and "today's pending" widgets. Uses the browser anon client (bridge JWT → RLS scopes automatically).

This path stays live because:
- Operational widgets need per-row detail (job id, due date, urgent flag).
- A 5-minute-old snapshot would let an expired order persist in the "due today" list.
- The matview is per-day aggregate granularity, not per-order.

### 2.2 Snapshot-backed summary (`/api/admin/dashboard/summary`)

Server route. Reads `public.dashboard_daily_snapshot` (materialised view from `20260531`) and returns `{ totals, snapshotRefreshedAt, usingSnapshot }`. Falls back to a live aggregation over `orders` for the last 30 days when the matview is empty (fresh deploy / first refresh pending).

Why a server route: the matview is granted to `service_role` only — RLS doesn't apply to matviews so we revoke `authenticated` reads. The route applies branch isolation:
- owner / hq_admin may pass `branchCode` (or `all`).
- branch_manager / front_staff / technician have their branchCode forced server-side.

Why the existing dashboards aren't fully ported: foundation phase. The summary is exposed as a `usingSnapshot` hint + freshness indicator; the role components still read per-row data from the live path. A future phase swaps `assembleKpis` to consume the snapshot for aggregate metrics.

---

## 3. Refresh model

| Trigger | Path |
|---|---|
| Manual | `POST /api/admin/dashboard/refresh-snapshot` (owner / hq_admin) — UI button on a future settings page; today it's curl-only. |
| Cron | `GET /api/admin/dashboard/refresh-snapshot` (Bearer `CRON_SECRET`). Vercel Cron / Supabase Cron call this every 15 minutes. |
| First refresh after deploy | The `refresh_dashboard_daily_snapshot()` SQL function tries `concurrently` and falls back to non-concurrent when the matview is `WITH NO DATA`. Operators don't need to do anything special. |

When the matview is empty, the summary route falls back to a 30-day live aggregation so the freshness indicator shows "⚡ live (fallback)" instead of an empty band.

---

## 4. Freshness indicator

The page header shows one of two states next to the branch selector:

| State | Meaning |
|---|---|
| `📊 snapshot · 2026-05-14` | The summary read came from the matview; the date is the latest `work_date` row in scope. |
| `⚡ live (fallback)` | Matview returned zero rows; summary was derived from a live read over the last 30 days. Operator action: run the refresh route. |

Hover (title attribute) reveals the full timestamp + source.

---

## 5. KPI helpers

Two separate consumer paths share the **same** primitives in [`lib/dashboardKpi.ts`](../lib/dashboardKpi.ts) (`getSalesToday`, `countByStatus`, `aggregateTopServices`, etc.). The role components compose them as needed.

Aggregated helpers in [`lib/aggregationService.ts`](../lib/aggregationService.ts) target snapshot consumers:
- `fetchBranchSalesSummary` — daily rows from the matview.
- `fetchPayrollTotals` — sums of `technician_payroll_items` for (branch, year, month).
- `fetchTopServices` — top-N completed services in a window.
- `fetchOverdueTrends` — bucketed overdue counts.
- `fetchCustomerGrowth` — new customers per day.

A consumer should call the helper that matches its need rather than re-implementing aggregation client-side.

---

## 6. Branch isolation across both paths

| Layer | Live path | Snapshot path |
|---|---|---|
| UI | Sidebar branch select locked for non-admin roles | Same |
| Server | RLS on `orders` / `customers` / `expenses` scopes reads | `/api/admin/dashboard/summary` forces branchCode for non-admin roles |
| Client fallback | `lib/dashboardData.ts` re-applies `.filter(o => o.branch_id === scope.branchCode)` | n/a — server already scoped |

---

## 7. Future enhancements (not this phase)

| Step | Why |
|---|---|
| Port `assembleKpis` to consume the snapshot | Today it walks the orders array client-side. Re-pointing it at the snapshot for monthly aggregates would push the dashboard to O(branches × days) reads. |
| Per-service snapshot row | Matview is day-granular. Adding service_code partition unlocks "top services" as a direct read. |
| Hour-level granularity | Day granularity covers monthly views; intraday widgets still need live. A `dashboard_hourly_snapshot` would help. |
| Snapshot refresh cron config | Library is ready; the actual Vercel/Supabase Cron entry is a deploy-time choice. |
| Snapshot age warning | Surface a yellow banner when `now() − snapshotRefreshedAt > 30 minutes`. Today the freshness indicator is informational only. |

---

## 8. Snapshot widget swap (post-2026-05-14)

The role-specific dashboards now opt into the snapshot for date-bucketed sales metrics. The wiring:

1. `app/page.tsx` calls `/api/admin/dashboard/summary` in parallel with the live fetch. The route now returns `rows[]` alongside `totals` so the client has per-day data to bucket.
2. `lib/dashboardSnapshotKpi.ts::assembleSnapshotKpis(rows)` produces a `SnapshotKpiBundle` with today / this-month / last-month sales, MoM growth, order counts. `hasData: false` when rows are empty so consumers know to fall back.
3. The bundle is passed as an optional `snapshotKpis` prop to ManagerDashboard, AccountingDashboard, and ExecutiveDashboard.
4. Each component checks `snapshotKpis?.hasData` and prefers the snapshot value for sales today / this month / last month. Operational counts (pending, in-progress, queues, urgent lists) stay live because they need per-row detail.

### 8.1 What's swapped

| Metric | Live → Snapshot? |
|---|---|
| `todayRevenue` | ✅ Snapshot when available |
| `monthRevenue` | ✅ Snapshot when available |
| `lastMonthRevenue` | ✅ Snapshot when available (Accounting + Executive) |
| `monthGrowth / monthOverMonthPct` | ✅ Snapshot when available |
| `yearRevenue` (YTD) | ❌ Stays live — lookback caps at 90 days |
| `weekRevenue` | ❌ Stays live — no week granularity in matview |
| `pending / inProgress / completed` counts | ❌ Stays live — per-row status |
| `topServices` | ❌ Stays live — no per-service breakdown in matview |
| `byCategory / byBranch` | ❌ Stays live — per-row attribute |
| Customer cohort + payment mix | ❌ Stays live — per-customer / per-row attribute |

### 8.2 Fallback semantics

`hasData: false` triggers fallback in every wired component — the existing live calculation path runs as before. The freshness indicator in the header shows `⚡ live (fallback)` when this happens; otherwise `📊 snapshot · YYYY-MM-DD`.

If `/api/admin/dashboard/summary` errors entirely, `snapshotKpis` is null and every dashboard component falls through to live as if the snapshot didn't exist. The page never blocks on the snapshot read.

### 8.3 Production behaviour

On a fresh deploy (matview empty):
- First page load: summary returns `usingSnapshot: false` + a live aggregation. Dashboard renders correctly.
- After `POST /api/admin/dashboard/refresh-snapshot` (or the cron variant): summary returns `usingSnapshot: true` + rows. Subsequent loads pull from the matview.

The per-row operational arrays (`snapshot.orders` from `lib/dashboardData.ts`) keep working regardless. Worst case the snapshot is stale; the freshness indicator shows the date so the operator can decide whether to refresh.

---

**Last updated:** 2026-05-14 (snapshot widget swap — ManagerDashboard / AccountingDashboard / ExecutiveDashboard wired)
