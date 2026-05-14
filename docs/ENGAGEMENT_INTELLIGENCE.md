# CareU OPS Platform — Engagement Intelligence + Retention Triggers + Email Templates

> **Status:** **live**. Customers are classified nightly into seven lifecycle states with an explainable reason. Six retention trigger kinds run on an hourly sweep, queueing one notification per customer through the existing dispatch pipeline. Operators edit shared templates with full version history, test-send any template at any channel, and view engagement KPIs on a per-branch dashboard.

---

## 1. Why this phase exists

Phase 17 made the communications stack **observable**. Phase 18 makes it **measurable + automated**:

- The dashboard answers "how many customers are at risk?" without a database query.
- The trigger engine reaches out on a defined cadence — operator doesn't need to remember.
- Templates are first-class, versioned, restorable — no more "we changed the SMS body in code last Tuesday".
- Every fired trigger carries its own `fired_reason` so the audit trail is self-explaining.

The platform now **assists** engagement. Human operators remain in control.

---

## 2. Schema (migration `20260542`)

| Table | Purpose |
|---|---|
| `customer_engagement_daily` | per (customer, date) snapshot. Driven by the nightly aggregator. |
| `customer_lifecycle_status` | current classification per customer with `reason` + `previous_status` + `changed_at`. |
| `retention_trigger_jobs` | one row per fired trigger. Dedup against `(customer_id, trigger_kind, recent)`. |
| `email_templates` | live template content with `slug` + `current_version`. |
| `email_template_versions` | append-only history. Save creates a v=N row BEFORE updating the live row to v=N+1. |

Four default templates ship: `overdue_pickup_reminder`, `we_miss_you`, `thank_you_followup`, `vip_reactivation`.

---

## 3. Lifecycle engine

`lib/customerLifecycle.ts::classifyLifecycle(inputs)` is a pure function. Top-down decision tree (first match wins):

| Status | Trigger | Notes |
|---|---|---|
| `churned` | days since visit > 365 | terminal |
| `dormant` | days since visit > 180 | not yet churned |
| `at_risk` | days since visit > 90 AND ≥ 3 prior orders | meaningful history + gone-quiet |
| `new` | first order < 30 days ago AND < 2 orders | early relationship |
| `loyal` | ≥ 8 orders AND active in last 90 days | top tier |
| `repeat` | ≥ 2 orders AND active in last 90 days | regular |
| `active` | 1 order ever AND active in last 90 days | foothold |

Every classification carries a `reason` string — `"95 ออเดอร์และไม่ได้กลับมา 95 วัน — at_risk"` etc. The reason is persisted on `customer_lifecycle_status.reason` so the operator who looks at a flagged customer sees exactly why.

Thresholds are exported as constants for unit tests + future flag-tunability.

---

## 4. Engagement aggregator

`lib/engagementMetricsService.ts::runEngagementAggregateTick(opts)` is the nightly worker. Per customer:

1. Compute inputs: `totalOrders`, `totalSpend`, `daysSinceVisit`, `daysSinceFirstOrder`.
2. Classify via `classifyLifecycle`.
3. UPSERT `customer_lifecycle_status` (sets `previous_status` + `changed_at` only on transitions).
4. Count today's comms (SMS / LINE / email sent + campaigns received) from `customer_notifications`.
5. Count today's cancellations from `orders`.
6. UPSERT `customer_engagement_daily` for the asOf date.

Per-tick limit defaults to 500 customers, ordered by `last_visit_at desc` so the most-active customers refresh first. Multiple ticks per day are safe (idempotent UPSERT).

`/api/cron/engagement-aggregate` is the HTTP entrypoint. Recommended cadence: daily at 02:30 Bangkok.

---

## 5. Retention trigger engine

`lib/retentionTriggerService.ts::runRetentionTriggerTick(opts)` sweeps the candidate pool for each trigger kind and queues one notification per match:

| Trigger | Condition | Dedup window | Default template |
|---|---|---|---|
| `no_visit_x_days` | last visit > 60 days, ≥ 1 prior order | 30 days | `we_miss_you` |
| `pickup_overdue` | order in `ready-for-pickup`, updated > 2 days ago | 7 days | `overdue_pickup_reminder` |
| `inactive_vip` | tier ∈ {gold, platinum, vip}, last visit > 45 days | 60 days | `vip_reactivation` |
| `high_spend_dormant` | lifetime_spend ≥ 5000 THB AND last visit > 180 days | 90 days | `vip_reactivation` |
| `birthday_month` | (not wired yet — needs DOB capture) | 365 days | `we_miss_you` |
| `first_time_followup` | total_orders = 1, last visit within 14 days | 365 days | `thank_you_followup` |

Per-tick limit: 100 candidates per kind. Each candidate runs through:

1. **Channel pick** — prefer LINE if linked; fall back to SMS if phone exists. Skip if neither.
2. **Dedup** — recent (customer × kind) in `retention_trigger_jobs` → skip.
3. **Policy gate** — `evaluatePolicy({intent: 'promotional'})` checks preferences + rate limit + recipient.
4. **Quiet hours** — `checkQuietHours()` (Bangkok 09:00–19:00 default). Outside → entire tick is a no-op with `blockedReason` recorded.
5. **Render** — `renderTemplate(slug, context, channel)`. Missing required variables → fail row.
6. **Enqueue** — `enqueueNotification(...)` → `customer_notifications`. Dispatch worker handles delivery.
7. **Write** — `retention_trigger_jobs` row with `status` + `skip_reason`/`fired_reason` + `notification_id`.

Every step writes a row to `retention_trigger_jobs` — operator sees the full audit on the engagement dashboard.

`/api/cron/retention-triggers` is the HTTP entrypoint. Recommended cadence: hourly. Quiet-hours guard makes off-hours ticks safe.

---

## 6. Email template engine

`lib/emailTemplateService.ts`:

- **Interpolation** — `{{variable_name}}` syntax. Whitespace inside braces allowed. Unknown vars stay as-is so typos are visible.
- **Required vars** — templates carry a `variables` JSONB array. `renderTemplate` returns `ok: false` when any required key is missing from context.
- **Per-channel selection** — `body_plain` for SMS / LINE; `body_html` for email (falls back to plain when not set).
- **Versioning** — `saveTemplateWithHistory` snapshots the current row into `email_template_versions` BEFORE overwriting. The live row's `current_version` increments. **The history is immutable** — no UPDATE/DELETE policies on the versions table.
- **Restore** — copies an old version's payload back onto the live row, which itself creates a new version snapshot first. Step-back is always reversible.

### Variables convention

| Variable | Meaning |
|---|---|
| `{{customer_name}}` | Customer display name (defaults to "ลูกค้า"). |
| `{{branch_name}}` | Branch receipt name (e.g. "C24 Care U"). |
| `{{job_id}}` | Order Job ID for order-related triggers. |
| `{{last_visit_date}}` | Last-visit date in Thai medium format. |
| `{{pickup_date}}` | Pickup due date. |
| `{{tracking_link}}` | Customer-facing tracking URL. |

The retention trigger engine wires the standard set above into every send. Custom triggers / broadcasts can add more keys via the segment / target payload.

---

## 7. APIs

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/admin/crm/engagement` | owner / hq_admin / branch_manager | Dashboard payload (lifecycle breakdown + 30d trend + churn risk + top returning + trigger summary + branch comparison). Branch-scoped customer pool for branch_manager. |
| `GET /api/admin/communications/templates` | owner / hq_admin | List all templates. |
| `POST /api/admin/communications/templates` | owner / hq_admin (30/10min/IP) | Create or update template. |
| `GET /api/admin/communications/templates/[id]` | owner / hq_admin | Single template + version history. |
| `DELETE /api/admin/communications/templates/[id]` | owner / hq_admin | Soft-disable (`enabled=false`). |
| `POST /api/admin/communications/templates/[id]/restore` | owner / hq_admin (20/10min/IP) | Restore from a version row. |
| `POST /api/admin/communications/templates/[id]/test-send` | owner / hq_admin (10/10min/IP) | Test send through the channel adapter. Bypasses queue + preferences. |
| `GET /api/cron/engagement-aggregate` | Bearer CRON_SECRET | Nightly aggregator. |
| `GET /api/cron/retention-triggers` | Bearer CRON_SECRET | Hourly trigger sweep. |

---

## 8. UI surfaces

- `/admin/crm/engagement` — lifecycle breakdown KPIs + 30-day retention trend + churn risk count + top returning customers + 24h trigger summary + branch comparison (owner/HQ).
- `/admin/communications/templates` — template grid + create button.
- `/admin/communications/templates/[id]` — edit form (subject / preview / body_plain / body_html / variables / channels / enabled) + live preview + test-send + version history with one-click restore.

Two new cards on `/admin` link to Engagement intelligence + Message templates.

---

## 9. Segmentation extensions

`SegmentDefinition` (consumed by `crmSegmentationService` and Phase 16 broadcast pipeline) now supports:

- `lifecycleStatuses` — filter by `customer_lifecycle_status.status` (new/active/repeat/loyal/at_risk/dormant/churned).
- `totalSpendLte` — upper bound on lifetime spend (paired with existing `totalSpendGte`).
- `totalOrdersLte` — upper bound on total orders.
- `dormantDaysGte` — alias for `inactiveDaysGte`, semantically "is dormant".
- `branchAffinityOnly` — placeholder (Phase 18 ships the field; same-branch is the default).

These plug into the existing audience builder (`/admin/crm/audiences`) and broadcast preview UIs without changes to those pages — the form rendering reads from the same definition.

---

## 10. Branch isolation

| Surface | Auth | Branch scope |
|---|---|---|
| `customer_engagement_daily` RLS | owner/HQ full / branch via customers.branch_id | enforced |
| `customer_lifecycle_status` RLS | owner/HQ full / branch via own row branch_id | enforced |
| `retention_trigger_jobs` RLS | owner/HQ full / branch_manager + front_staff via branch_id | enforced |
| `email_templates` RLS | owner/HQ full / others read-only branch-scoped | templates are global resources — branch_manager sees but doesn't edit |
| `/api/admin/crm/engagement` | role + branch_manager scoped customer pool | enforced |
| `/api/cron/retention-triggers` | Bearer CRON_SECRET | n/a — machine endpoint |

The retention engine itself doesn't enforce branch — it sweeps the global customer pool. Per-customer policy gates (preferences, opt-in) provide the only customer-visible safety check. To restrict triggers to one branch only, an operator currently has to flip the broadcast-side `enable_cross_branch_broadcasts` flag off (which the trigger engine doesn't read yet — future enhancement).

---

## 11. Known limitations

- **Birthday-month trigger is wired but inactive** — `customers` doesn't carry DOB. Operator adds DOB capture, the trigger lights up automatically.
- **Branch affinity filter is a placeholder** — `branchAffinityOnly` is a no-op until orders-per-branch tracking lands.
- **Engagement aggregator is best-effort idempotent** — running twice on the same day re-computes the same values, but a customer who orders mid-day won't reflect in tonight's snapshot unless the cron runs after them.
- **Retention trigger engine doesn't yet respect the cross-branch broadcast flag** — it sweeps globally. Per-branch overrides for trigger throttles are a future addition.
- **No campaign-response tracking yet** — `campaign_response_count` stays at 0 until customer-side click/reply capture lands (deferred phase).
- **No HTML email rendering pipeline** — templates carry HTML but the dispatch worker sends plain text; the Resend adapter when wired will pick up the HTML branch.
- **Trigger templates are hard-coded slugs in `TRIGGER_TEMPLATE_SLUG`** — operator can't yet map a different template to a trigger kind via UI. Reading from a per-trigger template_id column is a small future enhancement.
- **Test-send bypasses preferences** — by design (operator wants to see the message). But it also bypasses rate limits, so an operator who hits "test send" 100 times will burn provider quota. Rate-limited 10/10min/IP at the route layer to bound damage.

---

## 12. Cron schedule recap

| Cron | Cadence | Heartbeat name |
|---|---|---|
| Dispatch worker | 1 min | `dispatch-worker` |
| Retry worker | 5 min | `retry-worker` |
| Broadcast send | 1 min | `broadcast-send` |
| Overdue pickup | daily | `overdue-pickup-sweep` |
| HEIC transcode | 10 min | `heic-transcode` |
| **Engagement aggregate (new)** | **daily 02:30** | `engagement-aggregate` |
| **Retention triggers (new)** | **hourly** | `retention-triggers` |

The workers dashboard at `/admin/system/workers` shows all seven by default — adding a new cron is one entry in `lib/workerHealth.ts::CRON_EXPECTED_INTERVAL_MIN`.

---

**Last updated:** 2026-05-14 (phase 18 — engagement intelligence + retention triggers + email templates)
