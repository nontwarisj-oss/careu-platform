# CareU OPS Platform — Worker & Branch Health

> **Status:** operator reference. Companion to [WORKER_TELEMETRY.md](./WORKER_TELEMETRY.md) (telemetry schema) and [CRON_ARCHITECTURE.md](./CRON_ARCHITECTURE.md) (cron specs).

This doc covers the two health questions an operator asks:

1. **Is the platform healthy?** — crons + the global queue → `/admin/system/workers`.
2. **Is my branch healthy?** — per-branch operational rollup → `/admin/system/branch-health`.

---

## 1. Worker health (`/admin/system/workers`)

`lib/workerHealth.ts::computeWorkerHealth()` returns a `WorkerHealthSnapshot`:

- **`crons[]`** — per cron: last run, **next expected run** (manifest-derived), silence, **consecutive-failure streak**, 24h success rate, status, **recovery hint**.
- **`queue`** — queued / sending / failed / dead-letter totals, oldest-queued age, stuck-sending count.
- **`alerts[]`** — currently-breaching `communication_alert_rules`.

Per-cron status: `healthy` → `warning` (slow / 1–2 failures / <80% success) → `critical` (silent past 3× interval, or ≥3 consecutive failures).

### Recovery actions

| Symptom | Action |
|---|---|
| Cron `critical` — silent | Verify the scheduler; hit `/api/cron/<name>` manually with the Bearer secret. |
| Streak ≥ 3 | Read `last_failure_message`, fix root cause, then **Run maintenance**. |
| Queue stalled (oldest > 10 min) | **Self-heal** — resets stuck `sending` rows to `queued`. |
| Stale `worker_locks` | **Run maintenance** — or wait for the 15-min sweep. |

---

## 2. Branch health (`/admin/system/branch-health`)

`lib/branchHealth.ts::computeBranchHealth()` returns one `BranchHealth` per branch:

| Metric | Source | Bad when |
|---|---|---|
| `failedSends24h` | `customer_notifications status='failed'` (24h) | > 0 → warning |
| `deadLetters` | `customer_notifications status='dead_letter'` | > 0 → critical |
| `stuckBroadcastJobs` | `broadcast_send_jobs processing > 6h` | > 0 → critical |
| `unresolvedAlerts` | `alert_events active/acknowledged` for branch | > 0 → warning |
| `criticalAlerts` | of those, `severity='critical'` | > 0 → critical |
| `pausedCampaigns` | `broadcast_drafts status='paused'` | informational |

Branch status = worst of the above. Cards render worst-first.

**Access:** owner / HQ see every branch; a `branch_manager` sees only their own branch — the API (`/api/admin/system/branch-health`) scopes by the session's branch, not the request. The page uses the `recovery` page key so branch managers (who already have recovery access) can reach it.

---

## 3. Alert escalation chain

An unresolved `active` alert re-routes on a tiered chain (see [COMMUNICATIONS.md §10](./COMMUNICATIONS.md)):

`alert` (first fire) → **HQ escalation** (after 1× 2h cooldown) → **owner escalation** (every cooldown after). Acknowledging an alert stops escalation.

---

**Last updated:** 2026-05-15 (phase 24 — operational observability completion)
