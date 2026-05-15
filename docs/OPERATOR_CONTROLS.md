# CareU OPS Platform — Operator Controls

> **Status:** **fully operator-configurable**. Branch managers tune their own retention thresholds, quiet hours, and channel toggles. Owners hit the emergency stop. The public quote flow captures UTM + signed attribution. Orders auto-attribute back to campaigns. Funnel ROI breaks down by channel + branch.

---

## 1. Why this phase exists

Phase 19 closed the engagement feedback loop. Phase 20 removes the remaining hard-coded operational behaviour. Every retention threshold, every quiet-hour window, every send cap is now editable from `/admin/settings/*` without redeploy.

Three new safety primitives ship:

- **Per-branch trigger overrides** — already a table (Phase 19); now a UI.
- **Emergency stop** — owner-only kill switch. Flipping it halts dispatch + retention + broadcast tick within ~60s.
- **Daily / weekly caps** — global + per-branch ceilings the broadcast send API checks before queueing.

Plus the missing measurement layer:

- **UTM + signed `nid`** in campaign landing URLs.
- **Auto-attribution** wired from `lib/orderCreate.ts` → `/api/internal/attribute-order`.
- **Funnel writes** at delivered / opened / clicked / quote_started / order_created stages.
- **ROI dashboard** rolls up by channel + branch.

---

## 2. Schema (migration `20260544`)

| Table | Purpose |
|---|---|
| `campaign_funnel_metrics` | per (source, channel, branch, date) funnel counters. PK = composite. |
| `engagement_guardrails` | owner-managed safety layer. 5 default rows seeded. |
| `quote_requests.utm_*` + `attributed_notification_id` | quote-flow attribution columns. |
| `orders.attribution_source_*` | denormalised campaign reference on each order. |

---

## 3. Per-branch trigger overrides UI

`/admin/settings/triggers` — pick a branch, edit:

| Key | Type | What |
|---|---|---|
| `dormant_days` | number | Lifecycle "dormant" threshold (HQ default 180). |
| `at_risk_days` | number | Lifecycle "at_risk" threshold (HQ default 90). |
| `overdue_pickup_delay_days` | number | Pickup-overdue trigger grace (2). |
| `retention_cooldown_days` | number | no_visit_x_days dedup window (30). |
| `vip_reactivation_delay_days` | number | inactive_vip gap (45). |
| `max_daily_trigger_sends` | number | Advisory cap (200). |
| `quiet_hours_start_h` / `..._end_h` | number | Bangkok hour-of-day window (9–19). |
| `quiet_hours_enforced` | boolean | When false, branch ignores quiet hours (24/7 emergency branch). |
| `birthday_trigger_enabled` | boolean | Per-branch on/off for the birthday trigger. |

Save → server clears the in-process cache → next dispatch/retention tick reads the new value (≤ 60s).

API: `GET/POST /api/admin/settings/branch-triggers`. Audit row written to `cron_heartbeat_logs` (cron_name='settings-edit').

---

## 4. Quiet-hours enforcement

`lib/broadcastPolicyService.ts::checkQuietHours(now, branchId)` consults:

1. `branch_trigger_overrides.quiet_hours_enforced` — branch can opt out (return ok=true).
2. `branch_trigger_overrides.quiet_hours_start_h` / `..._end_h` (branch override).
3. Global `feature_flags.broadcast_quiet_hours_*` (Phase 16).
4. Hard-coded fallback (9–19).

Wired into:

- **Broadcast send worker** (`lib/broadcastSendWorker.ts`) — passes `job.branch_id`. Defers via `recordAttempt(blockedReason)` rather than failing.
- **Retention trigger sweep** (`lib/retentionTriggerService.ts`) — global check at tick top (sweep is per-tick-global; per-customer branch override applies via the per-target communicationPolicyService).
- **Lifecycle notifier** (existing Phase 13) — unchanged; transactional sends don't honour quiet hours.

Worker telemetry surfaces blocked ticks via the heartbeat row's `details.blockedReason`.

---

## 5. Engagement guardrails

`lib/engagementGuardrails.ts`:

| Key | Default | Effect |
|---|---|---|
| `global_emergency_stop` | false | Halts dispatch + retention + broadcast tick when true. Cache TTL 60s. |
| `max_sends_per_day_global` | 5000 | Across all branches per 24h. |
| `max_sends_per_day_branch` | 1000 | Per branch per 24h. |
| `max_campaigns_per_week_branch` | 5 | Broadcast send_jobs per branch per ISO week. |
| `dry_run_required` | false | When true, refuses live broadcasts without a prior completed dry_run for the draft. |

Wired into:

- `runDispatchTick` (Phase 12 worker) — returns immediately when emergency stop is true.
- `runBroadcastSendTick` (Phase 16) — per-job tick records `blockedReason="global_emergency_stop=true"`.
- `runRetentionTriggerTick` (Phase 18) — global-stop check.

The send caps are exported as helpers (`checkGlobalDailySendCap`, `checkWeeklyCampaignCap`, `checkDryRunRequirement`) for future wiring into the broadcast send-create API.

### UI

`/admin/system/guardrails` — Owner / HQ only. Big red "STOP all sends" button at top; per-row editor for each cap (global or per-branch). Every change writes a `cron_heartbeat_logs` audit row.

---

## 6. UTM helper

`lib/utm.ts`:

- `UTM_KEYS` = `['utm_source', 'utm_medium', 'utm_campaign', 'utm_branch', 'utm_channel']`.
- `buildCampaignUrl({baseUrl, utm, notificationId, ttlMs})` — appends utm_* + HMAC-signed `nid` token. Reuses `lib/trackingLinks.ts` signing.
- `parseUtmParams(urlOrQuery)` — strict pull (keys outside UTM_KEYS are dropped).
- `verifiedNotificationIdFromUrl(urlOrQuery)` — returns the verified nid or null.
- `attributionFromUrl(url)` — convenience for `{utm, notificationId}`.

The signed `nid` token can NOT be forged — verification uses `TRACKING_LINK_SECRET` from Phase 19. UTM params themselves are metadata, not security boundaries (anyone can manually visit `/quote?utm_source=foo` — that's fine).

---

## 7. Quote-origin attribution

`POST /api/public/quote` now:

1. Reads `body.utm` OR parses `body.referrerUrl` via `attributionFromUrl`.
2. Persists `utm_source / utm_medium / utm_campaign / utm_branch / utm_channel / attributed_notification_id` on the new `quote_requests` row.
3. When the `nid` token verifies, increments `campaign_funnel_metrics.quote_started_count` for the originating campaign (looks up the notification → resolves source kind/id → `incrementFunnel`).

The public quote form continues to require only the customer-supplied fields; UTM is optional and never required.

---

## 8. Auto-attribution wiring

`lib/orderCreate.ts::createSmartOrder` now calls `attributeOrderBestEffort(orderId, customerId, total, branchId)` after every successful insert. That POSTs to `/api/internal/attribute-order` which:

1. Calls `lib/campaignAttribution.ts::attributeOrderToCampaign` (Phase 19 — 14-day look-back).
2. On success: writes `attribution_source_kind` / `_id` / `_channel` to the orders row.
3. Calls `incrementFunnel` with `stage='order_created'` + `revenueThb` so the campaign's ROI rolls up.

Failures are best-effort — order creation never blocks on attribution.

---

## 9. Campaign funnel writer

`lib/campaignFunnel.ts::incrementFunnel({sourceKind, sourceId, channel, branchId, stage, revenueThb?})`:

- Reads the existing row at (source_kind, source_id, channel, branch_id, today) and increments the stage column by 1.
- Inserts a fresh row when the composite key has no match yet.
- `stage='order_created'` also adds `revenueThb` to `revenue_thb`.
- Best-effort + idempotent under repeated calls via PG's row-level locking on the existing-row path.

Write sites:
- Public quote endpoint — `stage='quote_started'` when verified nid lands.
- Attribute-order endpoint — `stage='order_created'` + revenue.
- Future: Resend webhook handler should also increment `delivered/opened/clicked`. The wiring is straightforward once we know the campaign source; not done in this phase to keep scope tight.

---

## 10. ROI dashboard extensions

`/admin/crm/engagement` adds a **Campaign funnel (30d)** section:

- 6 top stats: Delivered / Opened / Clicked / Quote started / Orders / Revenue.
- **By channel** column: SMS / LINE / email each rolled up.
- **By branch** column: per-branch delivered + orders + revenue.

Branch_manager sees own-branch funnel only.

---

## 11. New APIs

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET / POST /api/admin/settings/branch-triggers` | owner / HQ / branch_manager (own-branch write) | List + upsert branch override rows |
| `GET / POST /api/admin/system/guardrails` | owner / HQ | List + upsert guardrail rows, including emergency stop |
| `POST /api/internal/attribute-order` | any signed-in operator | Server-side attribution call from orderCreate |

---

## 12. Branch isolation

| Surface | Auth | Scope |
|---|---|---|
| `branch_trigger_overrides` RLS | role + branch_id | enforced |
| `engagement_guardrails` RLS | owner/HQ write; all read | enforced |
| `campaign_funnel_metrics` RLS | role + branch | enforced |
| `quote_requests.utm_*` | inherits Phase 15 RLS | unchanged |
| `/api/admin/settings/branch-triggers` | role + `requireBranchAccess` | enforced |
| `/api/admin/system/guardrails` | owner / HQ | enforced |
| `checkQuietHours(_, branchId)` | server-only | per-branch resolution |

---

## 13. Known limitations

- **Funnel `delivered`/`opened`/`clicked` not yet auto-written** from Phase 19's tracking endpoints + Resend webhook. The `incrementFunnel` helper exists; wiring it into those code paths is a 2-line follow-up — left out to keep this phase tight.
- **Daily / weekly caps not yet enforced at broadcast-send-creation** (the helpers `checkGlobalDailySendCap`, `checkWeeklyCampaignCap`, `checkDryRunRequirement` exist; calling them from `POST /api/admin/crm/broadcasts/[id]/send` is a small follow-up).
- **Emergency stop is global-only** for the dispatch worker — a per-branch emergency stop would require per-row checks on every dispatch attempt; reserved for a later phase.
- **Portal preferences extension** was minimised: existing Phase 13 toggles + Phase 19 DOB + Phase 19 per-branch unsubscribe cover the spec's "marketing SMS / LINE promotions / birthday campaigns" requirements via the existing UI surfaces. A "reminder frequency" toggle would need a new column on `customer_notification_preferences` — deferred.
- **`birthday_trigger_enabled` per-branch** is read at the UI/policy level but the retention sweep doesn't yet consult the override before fetching candidates. A 3-line follow-up.
- **UTM links not auto-generated by the broadcast send pipeline** — operators must wrap target URLs manually. A future "campaign URL builder" in the broadcast editor would close this gap.

---

## 14. Phase 20 cron schedule

No new cron paths. Existing 8 from Phases 12-19:

| Cron | Cadence |
|---|---|
| dispatch-worker / retry-worker / broadcast-send / overdue-pickup-sweep | unchanged |
| heic-transcode / engagement-aggregate / retention-triggers | unchanged |
| comm-performance-aggregate | unchanged |

Phase 22 adds **one** cron: `worker-maintenance` (every ~15 min) — lock janitor + alert sweep.

---

## 15. Phase 22 — cap enforcement, alerts, link wrap, lock janitor

The Phase 20 known-limitations list said the daily/weekly cap helpers existed but weren't wired. Phase 22 wires them and adds the alert + janitor layer. Full reference: [COMMUNICATIONS.md](./COMMUNICATIONS.md).

### 15.1 Caps now ENFORCED at send-create

`POST /api/admin/crm/broadcasts/[id]/send` blocks a campaign before the `send_job` insert when:

- the **global emergency stop** is on (dry-run included);
- the **global or per-branch daily send cap** is reached (live sends);
- the **weekly campaigns-per-branch cap** is reached (live sends) — *owner* may override with `{overrideWeeklyCap:true}`, audited;
- the **dry-run requirement** is unmet — needs a completed dry-run <14 days old AND newer than the draft's last edit.

Each block + each override writes a `broadcast_audit_log` row.

### 15.2 Alert events

`communication_alert_rules` breaches are now persisted to `alert_events` and surfaced on `/admin/system/workers` with acknowledge / resolve actions. New breaches route to Slack (real) + email/LINE (prepared). The `worker-maintenance` cron evaluates every ~15 min and auto-resolves cleared alerts.

### 15.3 URL auto-wrap

Broadcast bodies have their bare URLs auto-wrapped with signed click-tracking + UTM at fan-out. Operators stop hand-pasting tracking links.

### 15.4 Worker lock janitor

`worker-maintenance` deletes expired `worker_locks` rows every ~15 min; owner/HQ can force a sweep via **Run maintenance** on `/admin/system/workers`.

### 15.5 Smoke-test hardening

`/admin/system/smoke-test` adds checks for: send caps, alert-rule health, open alert count, `worker-maintenance` freshness, stale locks, `alert_events` table, and `NEXT_PUBLIC_BASE_URL` (link-wrap readiness).

---

## 16. Phase 23 — alert delivery + weekly digest

Phase 22 surfaced alerts in the dashboard. Phase 23 delivers them. Full reference: [COMMUNICATIONS.md §9](./COMMUNICATIONS.md).

### 16.1 Alert preferences

`/admin/system/alert-preferences` (owner/HQ) — set per branch (with a global default):

- **recipients** — alert email addresses (branch + global merged);
- **min severity** — `warning` (all) or `critical` only;
- **quiet hours** — Bangkok window holding back non-critical pushes (critical always routes);
- **enabled** — master delivery switch;
- **digest_enabled** — weekly digest opt-in.

### 16.2 Email activation

Set `EMAIL_PROVIDER=resend` + `EMAIL_API_KEY` + `EMAIL_FROM` to deliver for real. Unset = console-log mode (never crashes). `ALERT_SLACK_WEBHOOK_URL` adds Slack.

### 16.3 Escalation

An un-acknowledged `active` alert re-routes every 2 hours (`escalation_count` bumps). **Acknowledge** an alert on `/admin/system/workers` to stop escalation while you investigate; **Resolve** when fixed.

### 16.4 Weekly operator digest

`operator-digest` cron (weekly) emails a 6-section summary — sales, failed jobs, broadcast, CRM engagement, payroll warnings, branch comparison — to digest recipients. Owner/HQ may trigger early via **Send digest**.

### 16.5 Cron schedule addition

| Cron | Endpoint | Cadence |
|---|---|---|
| `operator-digest` | `GET/POST /api/cron/operator-digest` | weekly |

---

**Last updated:** 2026-05-15 (phase 23 — alert delivery + email routing + weekly digest)
