# CareU OPS Platform — Engagement Feedback Loop

> **Status:** **closed loop**. Per-branch trigger thresholds, optional DOB capture, block-composable HTML email, signed click+open tracking, Resend status webhook, campaign-to-order attribution, per-channel performance aggregates, and per-branch customer unsubscribe. Every retention send now answers "why did it fire, did the customer engage, did they return, did revenue change?".

---

## 1. Why this phase exists

Phase 18 made retention triggers fire on schedule. Phase 19 makes them **measurable**:

- Each fire has a documented reason that's branch-aware.
- Every send carries a signed open pixel + click links.
- Every click / open / bounce / unsub event lands in `communication_events`.
- Every customer-side order that follows a campaign within 14 days writes a `campaign_response_metrics` row with revenue + recovered-dormant flag.
- A nightly aggregator rolls comms performance into `communication_performance_daily` per (branch, channel, date) — the dashboard reads in O(1).

Operators stay in control. The platform now lets them prove ROI.

---

## 2. Schema (migration `20260543`)

| Table | Purpose |
|---|---|
| `branch_trigger_overrides` | per-branch threshold overrides (dormant_days, at_risk_days, etc.). Falls back to HQ defaults. |
| `customers.birth_date` + `customers.birth_month_verified` | optional DOB. Birthday trigger reads ONLY verified rows. |
| `communication_events` | append-only customer-side event stream (delivered/opened/clicked/bounced/complained/unsubscribed/failed). Replay-safe via unique (provider, provider_event_id). |
| `customer_branch_unsubscribes` | per (customer, branch, channel, scope) opt-out. Layered above the Phase 13 global prefs. |
| `campaign_response_metrics` | attribution rows linking campaign sends to subsequent orders (14-day window). |
| `communication_performance_daily` | per (branch, channel, date) aggregated open/click/bounce/latency counters. |

---

## 3. Per-branch trigger overrides

`lib/branchTriggerOverrides.ts::resolveNumber({ branchId, key, fallback })` — specific-branch row wins, else HQ default in `DEFAULTS`, else caller-supplied fallback. Cached 60 s.

Supported keys (with HQ defaults):

| Key | Default | Effect |
|---|---|---|
| `dormant_days` | 180 | lifecycle "dormant" threshold |
| `at_risk_days` | 90 | lifecycle "at_risk" threshold |
| `overdue_pickup_delay_days` | 2 | pickup_overdue trigger grace |
| `retention_cooldown_days` | 30 | dedup window for no_visit_x_days |
| `vip_reactivation_delay_days` | 45 | inactive_vip trigger gap |
| `max_daily_trigger_sends` | 200 | per-branch cap (advisory; not yet enforced) |
| `quiet_hours_start_h` / `quiet_hours_end_h` | 9 / 19 | local override for the global broadcast quiet hours |
| `quiet_hours_enforced` | true | branch can opt out of quiet hours |

Wired into:
- `lib/customerLifecycle.ts::classifyLifecycle({...}, overrides)` — `atRiskDays` + `dormantDays`.
- `lib/engagementMetricsService.ts` — resolves per-branch values before classifying each customer.
- (Future) The retention trigger service's per-kind dedup window will pull from `retention_cooldown_days`.

RLS: owner/HQ full control; branch_manager edits their own branch only.

---

## 4. DOB capture + birthday trigger

`customers.birth_date` (date, nullable) + `customers.birth_month_verified` (boolean default false). The portal profile page (`/portal/profile`) gains a DOB section — customer can set or clear it. Setting flips `birth_month_verified=true`.

Year is required by Postgres `date` but the trigger only uses the **month**. Privacy-conscious customers can store year=1900.

`lib/retentionTriggerService.ts` `birthday_month` candidates query:

```sql
SELECT … FROM customers
WHERE birth_month_verified = true
  AND birth_date IS NOT NULL
-- then filter in-app to rows whose month matches "now"
```

Backed by a partial index on `date_part('month', birth_date)`.

Dedup window: 365 days — at most one birthday message per year per customer.

---

## 5. HTML email renderer

`lib/email/renderers/blocks.ts` exports 7 composable block types:

| Block | Purpose |
|---|---|
| `hero` | brand-coloured headline + subtitle |
| `body` | paragraph with `\n` → `<br/>` |
| `cta` | rounded button with brand colour + target URL |
| `service_summary` | grey card with job-id / service / price / pickup |
| `pickup_reminder` | amber card flagging an overdue pickup |
| `coupon` | dashed green border placeholder code (no engine behind it yet) |
| `order_timeline` | done/current/pending dot list |
| `branch_contact` | footer with brand name + address |

`lib/email/renderers/layout.ts::renderEmailLayout({brand, preheader, blocks, unsubscribeUrl})` wraps the blocks in:

- 600px max-width responsive table layout (mobile-safe).
- Email-safe inline CSS only — no `<style>` blocks.
- `<meta name="color-scheme" content="light dark">` for dark-mode tolerance.
- Hidden preheader for inbox previews.
- Optional unsubscribe footer link.
- Plain-text fallback via `blocksToPlainText` for multipart/alternative.

No external dependency. Pure string concatenation. Server-only.

---

## 6. Signed tracking links

`lib/trackingLinks.ts`:

- HMAC-SHA256 token format `v1.<base64url(payload)>.<base64url(sig)>` signed with `TRACKING_LINK_SECRET` (falls back to `SESSION_SECRET`).
- Payload = `{ nid, url, exp, kind }`. 60-day TTL default.
- `buildClickUrl({baseUrl, notificationId, targetUrl})` produces a `/api/track/click?t=...` URL.
- `buildOpenPixelUrl({baseUrl, notificationId})` produces an `/api/track/open?t=...` 1×1 GIF URL.

The verifier rejects bad signature / expired tokens with constant-time comparison.

### Tracking endpoints

- `GET /api/track/click?t=<token>` — verifies, records `communication_events` with event_type='clicked', then 302-redirects to the target URL. Bad tokens redirect to `NEXT_PUBLIC_BASE_URL` with a forensic log row.
- `GET /api/track/open?t=<token>` — verifies, records 'opened', then returns a 1×1 transparent GIF regardless (so email clients don't show a broken image).

Both routes validate the target URL is `http(s):` only — `javascript:` / `data:` URLs go to the fallback.

---

## 7. Resend webhook

`POST /api/webhooks/email-status` — Svix-signed Resend webhook receiver.

- Signature: `svix-signature` header verified against `RESEND_WEBHOOK_SECRET`. Missing → 503, bad → 403.
- Event map: `email.delivered` → 'delivered', `.opened` → 'opened', `.clicked` → 'clicked', `.bounced` → 'bounced', `.complained` → 'complained', `.failed` → 'failed'.
- Notification linking via Resend tag `notification_id` (we attach it at send time on the future broadcast email path).
- Updates `customer_notifications.status` on delivered/failed (monotonic — no downgrade).
- Replay-safe via communication_events `(provider, provider_event_id)` unique index.

Operators configure their Resend webhook URL in the Resend dashboard.

---

## 8. Campaign attribution

`lib/campaignAttribution.ts::attributeOrderToCampaign({orderId, customerId, orderValue, branchId})`:

- Looks back 14 days for the most-recent customer_notifications row with `kind ∈ {broadcast, retention}` and `status ∈ {sent, delivered}`.
- Determines source via `kind`: broadcast → `broadcast_send_job` (id from `payload.broadcastJobId`), retention → `retention_trigger` (looked up via `retention_trigger_jobs.notification_id`).
- Reads current lifecycle status; `recovered_dormant = previous_status in {dormant, at_risk}`.
- Writes `campaign_response_metrics` row with frozen revenue + response_days.
- Unique on (source_kind, source_id, customer_id) — double-credit impossible.

Call site: future order-create hook. Phase 19 ships the library; wiring it into `lib/orderCreate.ts` is a one-line follow-up (left as a small task to avoid touching the create path in this huge phase).

---

## 9. Per-branch unsubscribe

`customer_branch_unsubscribes` lets a customer say "I want SMS, but not from C24 Saladaeng". Layered above Phase 13's global preferences:

- Phase 13 row = customer's GLOBAL choice ("I want SMS in general").
- Phase 19 row = customer's PER-BRANCH override ("…but not from Saladaeng").

Policy gate: `lib/communicationPolicyService.ts::evaluatePolicy` now takes `branchId` in context. For `intent='promotional'`, it consults `customer_branch_unsubscribes` after the global prefs and returns `bucket='branch_unsubscribed'` if a row matches.

Channel matching:
- Exact channel ('sms'/'line'/'email') unsubscribe vetoes that channel.
- Wildcard `channel='all'` vetoes all promotional channels for that branch.
- `scope='all'` vetoes both promotional AND transactional (rare — operator typically reserves this for customers who actively complain).

### Portal UI

`/portal/profile` now has:
- DOB section (Phase 19 — set / clear).
- Branch-unsubscribe list (Phase 19 — see + re-subscribe per row).

API: `GET/POST/DELETE /api/portal/unsubscribe`. Rate-limited 20/10min/IP.

---

## 10. Performance aggregator

`lib/commPerformanceAggregator.ts::runCommPerformanceAggregateTick({asOf})` — nightly worker. For each (branch, channel, date):

- Count sent/delivered/failed from `customer_notifications`.
- Count opened/clicked/bounced/unsubscribed from `communication_events`.
- Average `latency_ms` from `notification_dispatch_log`.
- UPSERT into `communication_performance_daily`.

Idempotent. Defaults `asOf=yesterday` so provider webhooks have time to settle.

`/api/cron/comm-performance-aggregate` — Bearer CRON_SECRET. Wrapped with heartbeat.

---

## 11. Engagement dashboard extensions

`/admin/crm/engagement` (extends Phase 18) now also shows:

- **Campaign ROI (30d)** — attributed orders, total revenue, dormant customers recovered, avg response days.
- **Comms performance (30d)** — per-channel send / delivered / open % / click % / bounced / unsubscribed. Plus overall avg dispatch latency.

Branch_manager sees only their branch's attributed orders + own-branch performance rows.

---

## 12. Trigger explainability

`/admin/crm/triggers` — list of retention_trigger_jobs with filters by status + kind. Each row shows:

- Customer name (linked to admin customer view).
- Trigger kind label.
- Channel + status pill.
- **Why fired:** `fired_reason` from the trigger service.
- **Why skipped:** `skip_reason` (preference / dedup / rate-limit / branch_unsubscribed / template render failure).
- Notification id (links to the dispatch_log via the customer admin view).
- Branch + timestamp.

Branch_manager sees own-branch rows only.

---

## 13. New APIs

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/track/click?t=...` | public (HMAC) | Click redirect + event record |
| `GET /api/track/open?t=...` | public (HMAC) | 1×1 pixel + event record |
| `POST /api/webhooks/email-status` | Svix signature | Resend delivery/open/click webhook |
| `GET /api/admin/crm/triggers` | role + branch | Recent retention trigger jobs |
| `GET/POST/DELETE /api/portal/unsubscribe` | customer cookie | Manage branch unsubscribes |
| `GET/POST /api/cron/comm-performance-aggregate` | Bearer CRON_SECRET | Nightly perf rollup |

---

## 14. Branch isolation

| Surface | Auth | Scope |
|---|---|---|
| `branch_trigger_overrides` | owner/HQ full; branch_manager own branch only | enforced |
| `communication_events` RLS | role + branch_id | enforced |
| `customer_branch_unsubscribes` RLS | role + branch | enforced |
| `campaign_response_metrics` RLS | role + branch | enforced |
| `communication_performance_daily` RLS | role + branch | enforced |
| `/api/admin/crm/triggers` | role + branch_id filter | enforced |
| `/api/portal/unsubscribe` | customer cookie | per-customer (own rows) |
| `evaluatePolicy` per-branch check | server-side | enforced |

---

## 15. Known limitations

- **DOB capture is portal-only.** No operator surface to edit a customer's DOB (privacy-safe default — customer must opt-in themselves).
- **Open tracking is best-effort.** Email clients with image-blocking (e.g. Apple Mail Privacy Protection) prefetch the pixel as soon as the message arrives — opens look 100% on Apple users. Operator should weigh open rate as a soft signal.
- **Click tracking only on emails wrapped with `buildClickUrl`.** A template that pastes raw URLs won't be tracked. Trigger engine currently doesn't auto-wrap — left for the future broadcast-send email integration.
- **Campaign attribution requires order-create wiring.** The library is shipped; calling it from `lib/orderCreate.ts` is the operator's next minor follow-up.
- **Resend webhook signature** verifies via Svix's HMAC format; if Resend ships a non-Svix delivery in future, the verifier needs updating.
- **Per-branch quiet hours not yet read by the broadcast policy service.** `lib/branchTriggerOverrides.ts` exposes the keys; the broadcast/policy code still consults the global `feature_flags`. Wiring is a small follow-up.
- **`max_daily_trigger_sends` is advisory.** The cap exists in the override table but the retention engine doesn't yet enforce a per-branch daily ceiling — wired in a future phase.
- **Coupon block has no validation.** The placeholder is just a styled string — no real coupon engine.
- **HTML email path requires Resend.** Provider needs to be flipped via `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` + webhook secret.
- **Trigger explainability page surfaces the last 100/500 rows.** No pagination yet.

---

## 16. Cron schedule

Adds `comm-performance-aggregate` to the existing list:

| Cron | Cadence | Heartbeat name |
|---|---|---|
| Dispatch worker | 1 min | `dispatch-worker` |
| Retry worker | 5 min | `retry-worker` |
| Broadcast send | 1 min | `broadcast-send` |
| Overdue pickup | daily | `overdue-pickup-sweep` |
| HEIC transcode | 10 min | `heic-transcode` |
| Engagement aggregate | daily | `engagement-aggregate` |
| Retention triggers | hourly | `retention-triggers` |
| **Comms performance** | **daily** | `comm-performance-aggregate` |

`/admin/system/workers` (Phase 17) automatically lists the new cron.

---

**Last updated:** 2026-05-14 (phase 19 — engagement feedback loop closed)
