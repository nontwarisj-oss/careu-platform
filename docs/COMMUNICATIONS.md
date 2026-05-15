# CareU OPS Platform — Communications Safety Layer

> **Status:** **capped, alertable, traceable, self-cleaning.** Every outbound campaign passes a cap gate at creation, every worker breach lands a persisted alert, every broadcast URL is auto-tracked, and stale worker locks are swept on a schedule.

This document covers the **operational safety layer** that wraps the communications pipeline (SMS / LINE / email dispatch, broadcasts, retention triggers). For the broadcast feature surface see [CRM_BROADCAST.md](./CRM_BROADCAST.md); for worker telemetry see [WORKER_TELEMETRY.md](./WORKER_TELEMETRY.md).

Introduced in **Phase 22** (migration `20260546`).

---

## 1. The four guarantees

| Guarantee | Mechanism |
|---|---|
| **Capped** | `POST /api/admin/crm/broadcasts/[id]/send` rejects over-budget campaigns before a `send_job` row is even created. |
| **Alertable** | `communication_alert_rules` breaches are persisted to `alert_events` and routed to operator channels. |
| **Traceable** | Every broadcast URL is auto-wrapped with a signed click token; every cap decision writes a `broadcast_audit_log` row. |
| **Self-cleaning** | The `worker-maintenance` cron sweeps expired `worker_locks` and auto-resolves cleared alerts every ~15 min. |

---

## 2. Cap enforcement flow

`POST /api/admin/crm/broadcasts/[id]/send` runs these gates **in order**, before the `broadcast_send_jobs` insert:

```
1. emergency stop ........ isEmergencyStopped()           → 409 if ON
2. (live only) daily cap . checkGlobalDailySendCap(branch) → 409 if global OR branch cap hit
3. (live only) weekly cap  checkWeeklyCampaignCap(branch)  → 409 unless owner override
4. (live only) dry-run ... checkDryRunRequirement(...)     → 409 if no fresh matching dry-run
5. channel / cross-branch / audience-cap / overlap (Phase 16/21, unchanged)
```

- All cap helpers live in [`lib/engagementGuardrails.ts`](../lib/engagementGuardrails.ts) and read `engagement_guardrails` (60s cache).
- `dry_run` mode sends skip gates 2–4 — a dry-run **is** how you satisfy the dry-run requirement — but **never** skip the emergency stop.
- **Per-customer caps** are NOT checked at send-create (it would mean N queries for an N-customer audience). They are enforced per-target at fan-out by `communicationPolicyService.evaluatePolicy → checkPerCustomerRateLimits`. The send-create gate covers the *campaign-scale* ceilings; the fan-out gate covers the *per-person* ceiling.

### Weekly-cap owner override

When `checkWeeklyCampaignCap` fails, the response carries `overridable: true`. An **owner** (only) may retry with `{ "overrideWeeklyCap": true }`. The override writes a `broadcast_audit_log` row with `after_value.guardrail = "override"`. `hq_admin` and `branch_manager` cannot override.

### Audit

Every blocked send AND every override writes a `broadcast_audit_log` row (`action='update'`, `after_value.guardrail ∈ {blocked, override}`) with the bucket, reason, actor, and IP.

---

## 3. Dry-run freshness

`checkDryRunRequirement({ draftId, branchId })` returns `ok` only when **all three** hold:

1. A `mode='dry_run'`, `status='completed'` send_job exists for the draft.
2. That dry-run is younger than **14 days** (`DRY_RUN_FRESH_WINDOW_MS`).
3. `broadcast_drafts.updated_at <= dry_run.created_at + 2s` — i.e. the draft has **not** been edited since the dry-run ran.

Editing the segment or template after a dry-run invalidates it; the operator must run a fresh dry-run. The 2-second skew tolerance allows a draft-save + dry-run queued in the same request.

The `dry_run_required` guardrail is **off by default** — turn it on per-branch or globally from `/admin/system/guardrails`.

---

## 4. URL auto-wrap

[`lib/campaignLinkWrapper.ts`](../lib/campaignLinkWrapper.ts) `wrapCampaignLinks({ body, notificationId, baseUrl, utm })`:

1. Scans the SMS / LINE / email body for `http(s)://` URLs.
2. Appends UTM params (`buildCampaignUrl` from [`lib/utm.ts`](../lib/utm.ts)).
3. Wraps the UTM-tagged URL in a signed click redirect (`buildClickUrl` from [`lib/trackingLinks.ts`](../lib/trackingLinks.ts)).
4. Skips URLs already pointing at `/api/track/click` or `/api/track/open` — **no double-wrapping**, idempotent.
5. The original URL is preserved inside the signed token payload; `/api/track/click` verifies then 302s to it.

**Wiring:** the broadcast send worker enqueues the notification with a **20-second `send_after` buffer**, then wraps the body using the freshly-minted `notification_id`, then patches `customer_notifications.payload.body`. The dispatch worker (which only picks rows with `send_after <= now`) cannot grab the row before the patch lands.

UTM applied per target: `utm_source=broadcast`, `utm_medium=<channel>`, `utm_campaign=<draft_id>`, `utm_branch=<branch>`, `utm_channel=<channel>`.

**Best-effort:** when `TRACKING_LINK_SECRET` or `NEXT_PUBLIC_BASE_URL` is unset, the body is sent unchanged — a campaign always sends even if tracking is off.

---

## 5. Alert routing flow

```
communication_alert_rules  (thresholds — Phase 17)
        │
        ▼
computeWorkerHealth()      (evaluates rules → AlertHit[])
        │
        ▼
recordAlertHits()          (lib/alertEvents.ts)
   ├── new breach   → INSERT alert_events row (status='active') → routeAlert()
   ├── repeat       → bump last_seen_at + occurrence_count (no re-route)
   └── cleared rule → auto-resolve open rows (resolved_via='auto')
        │
        ▼
routeAlert()               (lib/alertRouting.ts)
   ├── Slack  → real POST when ALERT_SLACK_WEBHOOK_URL set
   ├── Email  → intent-logged (ALERT_EMAIL_TO); provider send deferred
   └── LINE   → intent-logged (ALERT_LINE_TARGET); provider send deferred
```

- The `worker-maintenance` cron runs the full evaluation every ~15 min.
- **Dedup:** at most one open (`active`/`acknowledged`) `alert_events` row per `(rule_id, branch_id, metric)` — enforced by a partial unique index. A repeat breach bumps counters; it does **not** re-route (no incident spam).
- **Auto-resolve:** when a rule stops breaching, its open event flips to `resolved` with `resolved_via='auto'`.
- Only **new** breaches route. An ongoing incident routes once.

### Provider readiness

| Channel | Env switch | Phase 22 behaviour |
|---|---|---|
| Slack | `ALERT_SLACK_WEBHOOK_URL` | **Delivers** — Slack incoming webhook is a plain POST. |
| Email | `ALERT_EMAIL_TO` | Intent logged; real send deferred to a later phase. |
| LINE | `ALERT_LINE_TARGET` | Intent logged; real send deferred. |

---

## 6. Operator response playbook

| Symptom | Where | Action |
|---|---|---|
| Send blocked: `max_sends_per_day_*` | `/admin/system/guardrails` | Wait for the 24h window to roll, or raise the cap. |
| Send blocked: `max_campaigns_per_week_branch` | `/admin/crm/broadcasts/[id]` | Owner may re-send with override; or wait for the ISO week to roll. |
| Send blocked: `dry_run_required` | `/admin/crm/broadcasts/[id]` | Run a dry-run; if the draft was edited, run another. |
| Send blocked: `global_emergency_stop` | `/admin/system/guardrails` | Clear the emergency stop (owner/HQ). |
| Alert fired | `/admin/system/workers` | Acknowledge to signal "investigating", Resolve when fixed. Auto-resolves if the rule clears first. |
| Stale worker lock | `/admin/system/workers` → Run maintenance | Or wait — the cron sweeps every 15 min. |
| Campaign links not tracked | `/admin/system/smoke-test` | Check `NEXT_PUBLIC_BASE_URL` + `TRACKING_LINK_SECRET`. |

---

## 7. Worker lock janitor

[`lib/workerLockJanitor.ts`](../lib/workerLockJanitor.ts) `runLockJanitorTick()`:

- DELETEs every `worker_locks` row with `expires_at < now()`.
- Reports (does not delete) live locks held longer than **1 hour** — a clue the holder crashed without releasing and the TTL is too generous.
- Runs inside the `worker-maintenance` cron; also runnable on demand via the **Run maintenance** button on `/admin/system/workers` (owner/HQ).

`lib/workerLocks.ts` still clears a stale lock opportunistically on next acquire of the *same* name — the janitor is the backstop for locks whose cron stopped running entirely.

---

## 8. Cron schedule addition

| Cron | Endpoint | Cadence |
|---|---|---|
| `worker-maintenance` | `GET/POST /api/cron/worker-maintenance` | every ~15 min |

Bearer `CRON_SECRET` auth, wrapped with `withCronHeartbeat` + a `worker_locks` lock so two ticks never overlap.

---

## 9. Alert delivery (Phase 23)

Phase 22 made alerts *visible*. Phase 23 makes them *delivered* — operators no longer have to open a dashboard to learn something broke.

### 9.1 Routing pipeline

```
recordAlertHits()              (lib/alertEvents.ts)
   │  new breach
   ▼
resolveAlertPreferences(branch)   (lib/alertPreferences.ts — branch → global → default)
   │
   ▼
shouldDeliver(prefs, severity)    severity floor + quiet-hours gate
   ├── deliver=false → write ONE alert_deliveries row (status='skipped', reason)
   └── deliver=true
        ▼
   routeAlert(alert, { recipients })   (lib/alertRouting.ts)
        ├── email  → real send via lib/channels/email (one delivery per recipient)
        ├── slack  → ALERT_SLACK_WEBHOOK_URL POST
        └── line   → internal-notification placeholder (intent logged)
        ▼
   one alert_deliveries row per channel outcome (sent / failed / skipped)
```

### 9.2 Email provider activation

`lib/channels/email` already supported `EMAIL_PROVIDER` + `EMAIL_FROM`. Phase 23 adds `EMAIL_API_KEY` as the generic key name (`RESEND_API_KEY` still accepted as the legacy fallback).

| `EMAIL_PROVIDER` | Behaviour |
|---|---|
| `resend` | Real send via Resend — needs `EMAIL_API_KEY` (or `RESEND_API_KEY`) + `EMAIL_FROM`. |
| `console` / unset | Logs to console — **never crashes**. The default. |

### 9.3 Operator alert preferences

`/admin/system/alert-preferences` (owner/HQ) — `alert_preferences` table, one global row + per-branch overrides:

| Field | Effect |
|---|---|
| `recipients` | Email addresses. Branch + global recipients are **merged**. |
| `min_severity` | `warning` routes everything; `critical` suppresses warnings (still persisted/visible). |
| `quiet_hours_start_h` / `_end_h` | Bangkok window during which **non-critical** alerts are held back. Critical always routes. |
| `enabled` | Master switch — off = alerts persist but never push. |
| `digest_enabled` | Opt-in for the weekly operator digest. |

Resolution: per-branch row → global row → hard-coded defaults. 60s cache.

### 9.4 Dedup + escalation cooldown

- A repeat breach bumps `occurrence_count` — it does **not** re-route (no spam).
- A still-`active` (un-acknowledged) alert re-routes once per **2-hour escalation cooldown** (`ESCALATION_COOLDOWN_MS`), bumping `escalation_count`. Acknowledged alerts never escalate — the operator is already on it.
- When a rule stops breaching, its open event auto-resolves (`resolved_via='auto'`).

### 9.5 Weekly operator digest

`lib/operatorDigest.ts` builds a 6-section plain-text summary: weekly sales, failed jobs, broadcast performance, CRM engagement, payroll warnings, branch comparison. Each section is best-effort — a failed query degrades to `(unavailable)`, the digest still sends.

`/api/cron/operator-digest` (weekly cron) emails it to every recipient across `alert_preferences` rows with `digest_enabled`. Owner/HQ can also trigger it on demand via **Send digest** on `/admin/system/workers`. Every send writes an `alert_deliveries` row (`kind='digest'`).

### 9.6 Alert history

`alert_deliveries` records one row per delivery attempt: `kind` (alert/escalation/digest), `channel`, `recipient`, `status` (sent/delivered/failed/skipped). Surfaced on `/admin/system/workers` → **Alert delivery history**.

### 9.7 Env reference

| Env | Purpose |
|---|---|
| `EMAIL_PROVIDER` | `resend` or `console` (default). |
| `EMAIL_API_KEY` / `RESEND_API_KEY` | Resend API key. |
| `EMAIL_FROM` | Sender address. |
| `ALERT_SLACK_WEBHOOK_URL` | Slack incoming webhook (optional). |
| `ALERT_LINE_TARGET` | LINE placeholder target (optional; not yet delivered). |

---

## 10. Delivery confirmation + escalation chain (Phase 24)

### 10.1 Delivery confirmation

Customer-notification delivery already flowed through the webhooks (Phases 19–21). Phase 24 closes the loop for **operator-alert emails**:

- Each alert email's provider message id (`alert_deliveries.provider_message_id`) is captured at send time.
- The Resend webhook, when its event carries no `notification_id` tag, matches `alert_deliveries` by that id and advances the row `sent → delivered / failed` ([`lib/deliveryConfirmation.ts`](../lib/deliveryConfirmation.ts)).
- Forward-only + terminal — a duplicate or out-of-order webhook is a no-op.

### 10.2 LINE operator channel

`routeLine` ([`lib/alertRouting.ts`](../lib/alertRouting.ts)) now **pushes for real** via the LINE Messaging API. Target precedence: `alert_preferences.line_target` (per-branch) → `ALERT_LINE_TARGET` env. Token: `ALERT_LINE_TOKEN` → the global LINE OA token. A LINE user / group / room id all work as the push target. No token or target → safe no-op (`skipped`), workers never crash.

### 10.3 Escalation chain

An unresolved `active` alert re-routes once per 2h cooldown on a tiered chain:

| Tier | Trigger | Subject prefix |
|---|---|---|
| `alert` | first fire | ⚠️ Alert / 🚨 CRITICAL |
| `hq` | 1st escalation (≈ 2h unresolved) | ⏫ HQ ESCALATION |
| `owner` | every escalation after (≈ 4h+) | ⏫⏫ OWNER ESCALATION |

Acknowledging the alert stops escalation. Dedup + branch-awareness are unchanged from Phase 22.

### 10.4 Delivery audit trail

[`lib/deliveryTimeline.ts`](../lib/deliveryTimeline.ts)`::getNotificationTimeline` merges `customer_notifications` milestones + `notification_dispatch_log` attempts + `communication_events` engagement into one ordered trail: queued → dispatched → provider accepted → delivered → opened / clicked → failed / bounced → retried → cancelled. Surfaced via the `<DeliveryTimeline>` component (a **trail** toggle on each notification row of `/admin/customers/[id]`) and `GET /api/admin/system/delivery-timeline`.

### 10.5 Env reference (additions)

| Env | Purpose |
|---|---|
| `ALERT_LINE_TOKEN` | LINE channel token for operator alerts (else global LINE OA). |
| `ALERT_LINE_TARGET` | Default LINE user/group/room id (else per-branch `line_target`). |

---

## 11. Trustworthiness hardening (Phase 25)

- **Webhook trust** — every Twilio / Resend / LINE callback is signature-verified, replay-protected (`webhook_audit_log`), and audited. See [DELIVERY_PIPELINE.md §2](./DELIVERY_PIPELINE.md).
- **Escalation recipients** — `/admin/system/escalation-recipients` adds role-tiered contacts (owner / hq_admin / branch_manager / technician_lead) with severity routing, branch scope, fallback to `alert_preferences`, and temporary mute. The escalation chain (`lib/alertEvents.ts`) widens the audience per tier: `alert` → branch + technician lead; `hq` → + HQ; `owner` → + owner.
- **Delivery trace explorer** — `/admin/system/delivery-trace` searches any notification and shows its full timeline.
- **Provider reliability metrics** — success % / retry / bounce / click / callback latency / uptime, per provider + per branch, on `/admin/system/workers`.
- **Incident export** — `GET /api/admin/system/incident-export` bundles an incident as JSON or markdown.

---

**Last updated:** 2026-05-15 (phase 25 — trustworthiness hardening)
