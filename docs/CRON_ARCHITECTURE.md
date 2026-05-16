# CareU OPS Platform — Cron Architecture

> **Status:** permanent reference. The cron manifest ([`lib/cronManifest.ts`](../lib/cronManifest.ts)) and [`vercel.json`](../vercel.json) are the declarative source of truth — keep them in sync.

---

## 1. The manifest

Every scheduled job has one entry in [`lib/cronManifest.ts`](../lib/cronManifest.ts):

```ts
{ cronName, path, schedule, intervalMinutes, description }
```

[`vercel.json`](../vercel.json)'s `crons` array mirrors it (path + schedule). Adding a cron = add to the manifest, add the route under `app/api/cron/<name>`, add the line to `vercel.json`.

The manifest drives three things: the Vercel scheduler, the `/admin/system/workers` "next expected run" column, and the silence calibration in [`lib/workerHealth.ts`](../lib/workerHealth.ts).

---

## 2. The 11 crons

| Cron | Schedule (UTC) | Interval | Purpose |
|---|---|---|---|
| `dispatch-worker` | `*/5 * * * *` | 5 min | Drains the `customer_notifications` queue. |
| `retry-worker` | `*/10 * * * *` | 10 min | Re-attempts failed `sync_failures` with backoff. |
| `broadcast-send` | `*/5 * * * *` | 5 min | Fans out `broadcast_send_jobs` into the dispatch queue. |
| `retention-triggers` | `0 * * * *` | hourly | Dormant / at-risk / VIP retention sweep. |
| `overdue-pickup-sweep` | `0 6 * * *` | daily | Flags orders overdue for pickup. |
| `heic-transcode` | `*/15 * * * *` | 15 min | Transcodes pending HEIC uploads. |
| `reconcile` | `0 * * * *` | hourly | Google-Sheet reconciliation. |
| `engagement-aggregate` | `0 1 * * *` | nightly | Lifecycle + retention-score recompute. |
| `comm-performance-aggregate` | `0 2 * * *` | nightly | Per-branch per-channel delivery rollup. |
| `worker-maintenance` | `*/15 * * * *` | 15 min | Lock janitor + alert sweep + escalation. |
| `operator-digest` | `0 1 * * 1` | weekly | Weekly operator digest email. |

---

## 3. Cron contract

Every cron route:

1. **Auth** — `Bearer ${CRON_SECRET}`. Missing secret → 503; wrong secret → 401.
2. **Heartbeat** — wrapped in `withCronHeartbeat(name, handler)` → one row per invocation in `cron_heartbeat_logs`, plus a `cron_failure_streaks` upsert.
3. **Concurrency** — the four high-frequency / mutation-heavy crons (`dispatch-worker`, `broadcast-send`, `retry-worker`, `retention-triggers`, `worker-maintenance`, `operator-digest`) also pass `lockName` → a `worker_locks` row serialises overlapping ticks; the loser records a `skipped` heartbeat.
4. **Idempotency** — every cron is safe to run twice. Re-running a tick must not double-dispatch or double-count.

---

## 4. Self-cleaning jobs

`worker-maintenance` is the platform's housekeeper — every 15 min it:

- **Lock janitor** — deletes expired `worker_locks` rows ([`lib/workerLockJanitor.ts`](../lib/workerLockJanitor.ts)). "stale-lock-cleaner" + "heartbeat-check" from the original spec live HERE — they are not separate crons.
- **Alert sweep** — evaluates `communication_alert_rules`, persists breaches to `alert_events`, routes new ones, auto-resolves cleared ones, escalates unacknowledged ones.

---

## 5. Observability

`/admin/system/workers` reads `cron_heartbeat_logs` + `cron_failure_streaks` + the manifest and shows, per cron: status, schedule, last run, **next expected run**, silence, **consecutive-failure streak**, 24h success rate, and a **recovery hint**. A cron overdue past 1.5× its interval is flagged "missed".

---

---

## 6. Manifest drift guard (Phase 25)

[`lib/manifestDriftCheck.ts`](../lib/manifestDriftCheck.ts)`::checkManifestDrift` proves the three cron sources of truth agree:

| Source | Compared |
|---|---|
| `lib/cronManifest.ts` | the declared manifest |
| `vercel.json` | what the scheduler actually fires |
| `cron_heartbeat_logs` | what has actually run |

Findings:

- **missing** — in the manifest but absent from `vercel.json` → never fires.
- **orphan** — scheduled in `vercel.json` but absent from the manifest → unaccounted-for.
- **endpoint_mismatch** — same path, different schedule between manifest and `vercel.json`.
- **stale** — declared but no heartbeat within 3× its interval (or never).

Surfaced on `/admin/system/workers` (Cron manifest drift section) and as a `cron_manifest_drift` check in the smoke test. A `missing` or `orphan` finding is treated as critical.

---

---

## 7. Manifest CI gate (Phase 26)

`scripts/check-cron-manifest.mjs` is the **build-blocking** drift gate. It compares the three sources of truth — `lib/cronManifest.ts` (regex over the source), `vercel.json`, and the `app/api/cron/*` route directories — and exits non-zero on any: MISSING / ORPHAN / NO ENDPOINT / UNDECLARED / DUPLICATE.

- `pnpm check:crons` — run it standalone.
- `prebuild` npm hook — runs automatically before every `pnpm build`, so drift fails the build / CI before deploy.
- Runtime equivalent: `lib/manifestDriftCheck.ts` (workers dashboard + smoke test) — that one also checks heartbeat staleness, which needs the DB.

The 11 crons in the manifest each have a `/api/cron/<name>` route. `reconcile` is operator-triggered (`/api/admin/reconcile/run`) and is intentionally NOT a `vercel.json` cron — it is not in the manifest.

---

**Last updated:** 2026-05-15 (phase 26 — manifest CI gate)
