# CareU OPS Platform — Worker Telemetry + Self-Heal

> **Status:** **live**. Every cron writes a heartbeat. A dashboard surfaces queue depth, stuck jobs, cron silence, and alert breaches. An owner-only self-heal button unlocks stale rows.

---

## 1. Why this exists

The Phase 12–16 communications stack relies on five crons and a queue. If any of them silently stops, customers stop receiving messages — and the operator has no way of knowing until somebody complains at the counter. Phase 17 makes the worker layer **visible**:

- Every cron tick records start/end/duration/success/rows-processed.
- A dashboard reads those rows and computes per-cron health.
- The queue is scanned for "stuck" states (queued too long, sending too long).
- Operator-defined alert rules light up banners across the admin shell.
- A one-click self-heal endpoint unlocks the common stuck cases.

No silent failures. No blind cron jobs.

---

## 2. Schema (migration `20260541`)

| Table | Purpose |
|---|---|
| `cron_heartbeat_logs` | append-only row per cron INVOCATION. `cron_name`, `success`, `duration_ms`, `rows_processed`, `details`. |
| `communication_alert_rules` | operator-defined thresholds. `metric`, `comparison`, `threshold`, `window_minutes`, `severity`, optional `branch_id`. |
| `feature_flags` (Phase 16, PK fixed here) | `(key, branch_id)` unique via partial indexes. Global + per-branch rows now coexist correctly. |

Default alert rules (inserted by the migration):
- Delivery success below 85% in 60 min — warning.
- Dead-letter count above 5 in 24 h — warning.
- Oldest queued > 30 min — critical.
- Any cron silent > 15 min — critical.

---

## 3. Cron heartbeat wrapper

`lib/cronHeartbeat.ts::withCronHeartbeat(cronName, handler)` wraps every cron handler. Contract:
- ONE row per invocation, success or failure.
- Catches exceptions, writes `success=false` row, then re-throws so the cron's HTTP response still reflects the error.
- Heartbeat insert is best-effort — a broken telemetry table must not break actual cron work.

Wired into all five live crons:
- `dispatch-worker` (every minute)
- `retry-worker` (every 5 min)
- `broadcast-send` (every minute)
- `overdue-pickup-sweep` (daily)
- `heic-transcode` (every 10 min)

Each cron passes `rowsProcessed` + summary `details` so the dashboard can show "12 sent, 2 failed".

---

## 4. Worker health computation

`lib/workerHealth.ts::computeWorkerHealth()`:

1. For each known cron, fetch its most recent heartbeat → compute silence + last duration + last error.
2. Compute 24h success rate per cron.
3. Scan `customer_notifications` for `queued/sending/failed/dead_letter` — return totals + oldest queued age + stuck-sending count.
4. Evaluate all enabled `communication_alert_rules` against current metrics.
5. Roll up overall status: `healthy | warning | critical` (critical wins).

The thresholds for "healthy" vs "warning" vs "critical":

| Signal | Healthy | Warning | Critical |
|---|---|---|---|
| Cron silence | ≤ 1.5× expected | > 1.5× expected | > 3× expected |
| Success rate (24h) | ≥ 80% | < 80% | n/a here (alert rule fires) |
| Oldest queued (min) | ≤ 10 | n/a | > 10 |
| Stuck sending | 0 | > 0 | n/a |

---

## 5. APIs

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/admin/system/workers` | owner / hq_admin | Snapshot for the dashboard. |
| `POST /api/admin/system/recover-workers` | owner / hq_admin (5/10min/IP) | Runs 3 self-heal actions: reset stuck-sending rows; observe stuck broadcast jobs; observe long-running sending rows. |
| `GET / POST /api/admin/system/alert-rules` | owner / hq_admin | CRUD on alert rules. |
| `GET / POST /api/admin/settings/communications` | owner / hq_admin | Read all flags / write per-branch overrides. |

All system endpoints are owner / hq_admin only. Front_staff / technician / branch_manager are denied.

---

## 6. Self-heal actions

`/api/admin/system/recover-workers` runs three steps sequentially:

1. **recoverStuckSending** — finds `customer_notifications` rows in `status='sending'` older than 5 min and flips them back to `queued` with `send_after` pushed forward 30s. Most common cause: dispatch worker crashed mid-send.
2. **recoverStuckBroadcastJobs** — observes `broadcast_send_jobs` in `status='processing'` with no recent fan-out attempt. Does NOT auto-reset — operator action recommended (cancel + clone draft).
3. **detectInconsistentStates** — counts queue rows in `sending` for > 1h. Typically indicates a webhook isn't reaching us.

Every recovery action lands in `cron_heartbeat_logs` as a synthetic `cron_name='manual-recover'` row with actor + IP for audit.

---

## 7. Per-branch communications settings

`/admin/settings/communications` (Owner / HQ only):

- Select scope: Global or a specific branch.
- Toggle channels (SMS / LINE / scheduled / cross-branch).
- Set quiet-hour window + audience cap + dedup window.
- Save (POST upserts override rows). "Revert" deletes a branch override and falls back to global.

The cache TTL is 60 s, so a save is visible to all serverless functions within a minute. The settings page invalidates its own process cache immediately on save.

---

## 8. Unhealthy banner

`components/WorkerHealthBanner.tsx`:

- Polls `/api/admin/system/workers` every 60 s when mounted.
- Renders nothing when overall=healthy.
- On warning/critical: shows a coloured banner with a 1-line summary (silent cron / stuck rows / dead-letter count / alert hits) + a link to the workers dashboard + a "ซ่อน 30 นาที" dismiss button (session-only).
- Embedded on `/admin` + `/admin/dispatch`. Operators see a problem the moment they open the admin shell.

---

## 9. Email channel foundation

`lib/channels/email/index.ts`:

- `EmailProvider` interface — `send({to, subject, body, meta})` returns `EmailSendResult`.
- `ConsoleEmailProvider` (default) — logs via `console.info`.
- `ResendEmailProvider` (placeholder) — wired against `https://api.resend.com/emails`, awaits env config.
- `getEmailProvider()` reads `EMAIL_PROVIDER` env (`console` | `resend`), caches.
- `sendEmail(input)` convenience wrapper.

Dispatch worker's `dispatchEmail` reads `row.payload.{email, subject, body}` and routes through `sendEmail`. Failures captured the same way as SMS — retryable flag governs whether the queue retries or dead-letters.

No mass email yet — broadcast support for the email channel will land alongside a real provider integration.

---

## 10. Unified communications timeline

The admin customer view (`/admin/customers/[id]`) adds a "Unified comms timeline (30)" section interleaving:

- `customer_notifications` rows (intent + status).
- `notification_dispatch_log` rows (per-attempt outcome + latency).
- `line_delivery_log` rows (LINE push acks + unfollows).

All three are sorted by their respective timestamps and rendered in a single vertical list, colour-coded by tone. Operators see "we tried at X, succeeded at Y, customer unfollowed at Z" in one place.

---

## 11. Health widget on /admin/dispatch

Phase 17 adds the `WorkerHealthBanner` to the dispatch page so the operator who's investigating queue failures gets the same single-line health summary inline. The existing Phase 14 observability panel + Phase 16 broadcast health remain unchanged.

---

## 12. Known limitations

- **Heartbeat covers only the FIVE crons.** Manual recovery triggers (admin "run tick" buttons) don't write heartbeat rows. Operators see them in the existing dispatch_log + audit trails.
- **Self-heal doesn't auto-reset broadcast jobs.** "stuck broadcast" is observed-only. Auto-resetting could un-pause a job an operator deliberately paused — too risky for one-click recovery.
- **No paging alert delivery.** When a rule breaches we render a banner; nobody is woken up by SMS / Slack. External uptime monitoring is the right answer; the dashboard is the local "is this alive" view.
- **Per-branch alert rules are stored but not yet filtered in the UI.** A rule with `branch_id=X` evaluates against global metrics; future enhancement would scope the metric query.
- **Email channel doesn't support templates yet.** Body is plain text only. Marketing email campaigns will need an HTML rendering pipeline.
- **Settings cache TTL is 60 s.** A flag flip is visible within a minute on every function instance. Faster propagation would need a cache-invalidation broadcast (Postgres NOTIFY, Redis, etc.) — overkill for this phase.
- **The unhealthy banner polls per session.** A truly global "everyone sees the banner" needs a persistent toast layer — outside Phase 17's scope.

---

## 13. Cron schedule recap

| Cron | Recommended interval | Heartbeat name |
|---|---|---|
| Dispatch worker | 1 min | `dispatch-worker` |
| Retry worker | 5 min | `retry-worker` |
| Broadcast send | 1 min | `broadcast-send` |
| Overdue pickup | daily (mid-day) | `overdue-pickup-sweep` |
| HEIC transcode | 10 min | `heic-transcode` |

If a cron's interval changes, update `CRON_EXPECTED_INTERVAL_MIN` in `lib/workerHealth.ts` so the silence detector calibrates correctly.

---

## Phase 21 — concurrency control + failure streaks

- **`worker_locks`** — a distributed advisory lock table. `withCronHeartbeat(cron, handler, { lockName })` acquires a row before the handler runs; a second concurrent tick short-circuits with a `skipped` heartbeat. Wired into `dispatch-worker`, `broadcast-send`, `retry-worker`, `retention-triggers`, `worker-maintenance`.
- **`cron_failure_streaks`** — per-cron consecutive-failure counter, reset on every success. `/admin/system/workers` shows a `×N` badge; warning at ≥1, critical at ≥3.

## Phase 22 — alert events + worker-maintenance cron

- **`alert_events`** — persisted alert breaches. `communication_alert_rules` breaches no longer evaporate between dashboard loads; they land a row with an `active → acknowledged → resolved` lifecycle. Dedup: one open row per `(rule_id, branch_id, metric)`. Auto-resolved when the rule stops breaching.
- **`worker-maintenance` cron** — `GET/POST /api/cron/worker-maintenance`, every ~15 min. Runs the lock janitor ([`lib/workerLockJanitor.ts`](../lib/workerLockJanitor.ts)) + the alert evaluation/routing sweep ([`lib/alertEvents.ts`](../lib/alertEvents.ts)). Add it to `CRON_EXPECTED_INTERVAL_MIN`.
- **`/admin/system/workers`** — adds the persisted-alert surface (acknowledge / resolve buttons) + a **Run maintenance** button (owner/HQ) for an on-demand sweep.
- **Alert routing** — new breaches route to Slack (real, when `ALERT_SLACK_WEBHOOK_URL` is set) + email/LINE (intent-logged, provider send deferred). See [COMMUNICATIONS.md §5](./COMMUNICATIONS.md).

## Phase 23 — alert delivery + weekly digest

- **`alert_preferences`** — operator-managed routing config (recipients, severity floor, quiet hours, digest opt-in), one global row + per-branch overrides. Edited at `/admin/system/alert-preferences`.
- **`alert_deliveries`** — one row per delivery attempt (`kind` alert/escalation/digest, `channel`, `recipient`, `status`). Surfaced on `/admin/system/workers` → **Alert delivery history**.
- **`alert_events` += `last_routed_at` + `escalation_count`** — drives the 2-hour escalation cooldown: an un-acknowledged alert re-routes once per window instead of going silent.
- **Email is live** — alerts route through `lib/channels/email` for real when `EMAIL_PROVIDER=resend`; console fallback otherwise (never crashes).
- **`operator-digest` cron** — `GET/POST /api/cron/operator-digest`, weekly. Emails the 6-section operator digest to every `digest_enabled` recipient. Manual trigger: **Send digest** button on `/admin/system/workers`.

Full reference: [COMMUNICATIONS.md §9](./COMMUNICATIONS.md).

---

**Last updated:** 2026-05-15 (phase 23 — alert delivery + weekly digest)
