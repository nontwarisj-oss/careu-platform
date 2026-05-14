# CareU OPS Platform — SMS Provider + Dispatch Worker

> **Status:** **live**. `customer_notifications` is drained by a real worker (cron + manual). SMS routes through an adapter (console / Twilio); LINE routes through the existing channel-config orchestrator. Email / in-app remain manual surfaces.

---

## 1. Why an adapter

The platform sends transactional messages from many code paths — OTP issuance, order-ready notifications, the phone-change flow. Two costs we wanted to avoid:

1. **Hard-coupling to one vendor.** Whichever Thai SMS aggregator (Twilio, Infobip, SMSMasterGSM, etc.) we pick first will not be the one we run with in 18 months. A direct `axios.post(TWILIO_URL, …)` call in `customerOtp.ts` would tie us to that vendor forever.
2. **Local dev needs to work without an account.** Every developer should not need to spin up a Twilio sandbox to test the OTP flow.

`lib/smsProvider.ts` is the answer:

- `SmsProvider` interface: one method `send(SmsSendInput) → Promise<SmsSendResult>`.
- `ConsoleSmsProvider` (default): logs to `console.info`, succeeds. Used in dev + on machines that don't set `SMS_PROVIDER`.
- `TwilioSmsProvider`: POSTs to Twilio's REST API with HTTP Basic auth, e164-normalises Thai numbers to `+66…`. Wired but not enabled by default.
- `getSmsProvider()`: reads `SMS_PROVIDER` env (`console` | `twilio`), caches the chosen provider for the function lifetime.
- `sendSms(input)`: convenience wrapper everyone else imports.

To swap providers in production, set `SMS_PROVIDER=twilio` + `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_FROM` and redeploy. No code change at any call site.

---

## 2. Where SMS is sent

| Call site | What | Failure mode |
|---|---|---|
| `lib/customerOtp.ts::issueCustomerOtp` | 6-digit code, 5-min TTL | Fire-and-forget — provider outage does NOT block OTP issuance. Customer can still use `123456` in non-production. |
| `app/api/portal/phone-change/request/route.ts` | 6-digit code to the **new** phone | Same fire-and-forget — `phone_change_requests` row is committed regardless. |
| `lib/notificationDispatchWorker.ts::dispatchSms` | Any queued SMS row | Outcome routed through the queue's normal retry/dead-letter machinery. |

The OTP paths are *fire-and-forget* on purpose. A flaky SMS provider must never block the user-visible response. The dispatch worker, by contrast, awaits the result because that's its whole job.

---

## 3. The dispatch worker

`lib/notificationDispatchWorker.ts::runDispatchTick(opts)` drains pending rows in `customer_notifications`.

### 3.1 State machine

```
queued ──► sending ──► sent ──► delivered  (Twilio webhook confirms)
                            └─► failed     (provider webhook says failed/undelivered)
                  └──► queued     (transient failure; send_after += backoff)
                  └──► dead_letter  (non-retryable OR attempts ≥ MAX_ATTEMPTS)
                  └──► skipped     (rate-limit / no recipient / no dispatcher)

queued / sending ──► cancelled (operator action via /api/admin/notifications/cancel)
```

`failed` (Phase 14+) means "transient, awaiting backoff retry"; `dead_letter` means "out of the retry loop". The status enum was extended in migration `20260538` to make this distinction explicit. Older rows that predate the migration may still carry `failed` as their terminal — `/admin/dispatch` surfaces both under the "Dead-letter" KPI.

- **Optimistic concurrency.** The transition `queued → sending` is `UPDATE … WHERE status = 'queued'`. If two workers race, only one wins; the other gets zero rows and skips the row with a `skipped` outcome.
- **Per-row try/catch.** Every per-row exception is captured as a `failed` outcome with `retryable=true`. A misbehaving row cannot take down the whole tick.
- **Channel routing.** `dispatchSms` calls `sendSms()`; `dispatchLine` resolves the branch's channel config (via `resolveLineChannelConfig`) and calls `pushTextMessage`. Email + in-app return a non-retryable "manual only" outcome — the queue retains them, but the worker doesn't try.

### 3.2 Backoff

`backoffSeconds(attempts) = min(60 × 3^(attempts−1), 10800)`:

| Attempts | Next wait |
|---|---|
| 1 | 60 s |
| 2 | 3 min |
| 3 | 9 min |
| 4 | 27 min |
| 5 | 3 h (capped) |

`MAX_ATTEMPTS = 5`. After the 5th attempt the row lands in `failed` regardless of provider outcome — this is the dead-letter, surfaced in the admin UI.

### 3.3 Retryability

`SmsSendResult.retryable` and the LINE HTTP status determine whether a failure stays in the queue or moves to `failed`:

| Source | Retryable? | Examples |
|---|---|---|
| SMS provider | provider-supplied flag | Twilio 5xx → yes; 4xx (invalid number) → no |
| LINE push | status ≥ 500 | network / LINE outage → yes; LINE 4xx (user unfollowed) → no |
| Missing config | no | LINE channel token unset, branch row missing, etc. |
| Payload missing | no | `payload.phone` / `payload.body` absent — bad row, dead-letter immediately |

---

## 4. Triggering the worker

Three entry points, all share `runDispatchTick`:

| Endpoint | Auth | Use case |
|---|---|---|
| `GET / POST /api/cron/dispatch-worker` | `Authorization: Bearer ${CRON_SECRET}` | Scheduled cron (Vercel cron / external scheduler) |
| `POST /api/admin/dispatch/run` | `requireRole(['owner','hq_admin'])` | Manual flush from the admin UI |
| `runDispatchTick(opts)` directly | Server-only | Tests, ad-hoc scripts |

`DEFAULT_LIMIT = 25` per tick; `MAX_LIMIT = 100` enforced by the route. Tune the cron cadence to match expected throughput.

## 4a. Twilio delivery webhook

`POST /api/webhooks/twilio-status` is the Twilio MessageStatus callback. Configure it in the Twilio console (or per-message StatusCallback URL) to point at this endpoint.

- **Auth:** signed via `X-Twilio-Signature`, verified with `TWILIO_AUTH_TOKEN`. Missing token returns 503; bad signature returns 403. A forged callback cannot mark a row as `delivered`.
- **Idempotent:** the route only applies forward transitions per `STATUS_RANK`. Replay of an old "sent" callback after a "delivered" is a no-op. Same-status callbacks refresh `last_provider_status` only.
- **Join key:** `provider_message_id` (the Twilio SID). The dispatch worker captures it when `sendSms` returns; if Twilio races us and the SID isn't in our DB yet, the route logs an entry to `notification_dispatch_log` with `notification_id=null` so the operator can grep.
- **Customer-visible side-effects:** when a status transitions to `delivered` / `failed`, a `customer_activity` row is written with `kind=notification_delivered` / `notification_failed`. The portal `/portal/profile` activity feed surfaces these.

## 4b. Operator manual sends

`POST /api/admin/notifications/send` triggers a lifecycle notification on demand from the OPS UI (the "แจ้งลูกค้าด้วยตนเอง" menu on `/orders/[id]/document`).

- Sets `force: true` so the lifecycle notifier's 6-hour dedup window does NOT block the operator. The per-customer rate limiter still applies — that's the real spam guard.
- Allowed events: `ready_for_pickup` / `overdue_pickup` / `payment_received` / `order_completed`. The lifecycle-only events (`order_created`, `repair_started`) are not operator-triggerable — those should fire from real status transitions.
- Writes `notification_resend_log` with `action='resend'` and `reason="manual send: …"` so the audit trail shows operator intent.

## 4c. Resend + cancel

`POST /api/admin/notifications/resend` — admin re-queues a specific notification id. Creates a NEW row with `resent_from = original.id`, status=`queued`, attempts=0. The original row is untouched. Audited in `notification_resend_log` with `action='resend'` (or `'dead_letter_retry'` when the original was already terminal-dead).

`POST /api/admin/notifications/cancel` — only valid on rows in `queued` / `sending`. Sets `status='cancelled'`, `cancelled_at=now`, `cancelled_by=actor`. Race-safe — the optimistic-concurrency `WHERE status IN ('queued','sending')` clause means if the worker has already started the row, the cancel is a no-op and returns 409.

Both endpoints require `requireRole + requireBranchAccess` and are rate-limited 30/10min/IP.

---

## 5. Monitoring UI

`/admin/dispatch` (file: `app/admin/dispatch/page.tsx`) — Owner / HQ only. Surfaces:

- **Counts by status** — queued / sending / sent / **delivered** / failed / **dead_letter** / skipped / **cancelled**.
- **Recent failures (25)** — channel, kind, attempts, error_reason, branch + a **Resend** button per row.
- **Pending preview (25)** — what the next tick will pick up + a **Cancel** button per row.
- **Manual "รัน tick (25)"** — calls `/api/admin/dispatch/run`. Result expanded inline with per-row outcomes.
- **Observability (24h)** — success rate %, avg retry depth, provider p50/p95 latency, per-hour trend, per-channel breakdown.
- **Resends (24h)** — total + breakdown by action (`resend`/`cancel`/`dead_letter_retry`).
- **Rate-limit triggers (24h)** — count by bucket (`same_kind_cooldown`/`per_channel_hour`/`per_channel_day`/`total_per_hour_customer`/`total_per_day_order`). When > 0, the panel turns amber to draw the operator's eye.
- **SMS provider** — current value of `SMS_PROVIDER` env. Confirms which adapter is wired without SSH.

The page is the operator's primary view onto async customer comms — sibling to `/admin/recovery` (which monitors `sync_failures`).

---

## 6. Database

Migration `20260536_phone_change_and_dispatch.sql`:

- `phone_change_requests` table (id, customer_id, current_phone, new_phone, code_hash, expires_at, verified_at, cancelled_at, attempts, created_at).
- Unique partial index `phone_change_requests_new_phone_pending_uniq ON (new_phone) WHERE verified_at IS NULL AND cancelled_at IS NULL` — prevents two concurrent claims on the same new number.
- `customer_notifications_channel_status_idx ON (channel, status)` — speeds the worker's per-channel queue scan.
- `customer_notifications_failed_idx ON (created_at DESC) WHERE status = 'failed'` — speeds the dispatch UI's recent-failures query.

Migration `20260537_customer_engagement_layer.sql` (Phase 13):

- `customer_notification_preferences` — per-customer channel + kind toggles.
- `notification_dispatch_log` — per-attempt telemetry.
- Extended `order_audit_log.action` enum.

Migration `20260538_communications_maturity.sql` (Phase 14):

- Expanded `customer_notifications.status` enum: + `delivered`, `dead_letter`, `cancelled`.
- New columns on `customer_notifications`: `delivered_at`, `provider_message_id`, `last_provider_status`, `cancelled_at`, `cancelled_by`, `resent_from`.
- Sparse index on `provider_message_id` for the Twilio webhook lookup.
- Per-customer rate-limit index `(customer_id, channel, created_at DESC)`.
- `notification_resend_log` — append-only audit of resend/cancel/dead-letter-retry actions.
- `media_transcode_queue` — HEIC normalization pipeline source.

RLS is off on `phone_change_requests` (server-only writes via service role, same pattern as `customer_otp_codes`).

### 6a. Per-customer rate limits

`lib/customerRateLimit.ts::checkPerCustomerRateLimits` runs BEFORE each dispatch attempt. Five buckets:

| Bucket | Limit | Why |
|---|---|---|
| `same_kind_cooldown` | 30 min | catches the same (kind+order+channel) firing twice in close succession |
| `per_channel_hour` | SMS 4, LINE 8, email 4 | per-channel hourly cap; SMS is tightest because each one costs real money |
| `per_channel_day` | SMS 12, LINE 30, email 20 | per-channel daily cap; "the customer should never see 20 SMS in one day from us" |
| `total_per_hour_customer` | 10 | across-channel hourly cap; catches status thrashing |
| `total_per_day_order` | 6 | across-channel daily cap PER ORDER; protects against per-order template loops |

When any limit fires, the worker marks the queue row as `skipped` with `error_reason='rate-limit: <bucket> — <reason>'` and writes a `notification_dispatch_log` row with `outcome='skipped'` and `details.rateLimitBucket=<bucket>`. The observability panel counts these and surfaces totals + per-bucket breakdown.

The limiter does NOT apply to `in_app` channel rows — those don't hit a real provider.

### 6b. HEIC transcode pipeline

`lib/uploadClient.ts::compressImageIfBeneficial` tags HEIC bytes that the browser couldn't decode with `needsTranscoding: true`. `app/api/portal/upload-url/route.ts` consumes that hint AND auto-detects HEIC MIME types, inserting a row into `media_transcode_queue` with `status='pending'`.

`app/api/cron/heic-transcode/route.ts` is the drainer. Auth via `Bearer CRON_SECRET`. Per-row: flag as `processing`, transcode, write the output path, mark `done`. On failure: increment attempts, dead-letter after 3.

The actual transcoder is a placeholder (`HEIC_TRANSCODER=stub`). When an operator wires `sharp + libheif` (or a Supabase Edge Function with libvips), they replace `transcodeHeicToJpeg`. Until then:

- HEIC bytes still upload and persist — iOS Safari can render them natively.
- Other browsers see "broken image" in the gallery for HEIC uploads.
- Queue rows stay in `pending` indefinitely (the cron returns "deferred").
- Set `HEIC_TRANSCODER=disabled` to mark pending rows as `dead_letter` instead — useful for shutting the feature off in a deploy.

Recommended schedule when wired: every 10 minutes. Cron Bearer auth matches the other cron routes.

---

## 7. Env vars

| Var | Required when | Default |
|---|---|---|
| `SMS_PROVIDER` | always (defaults to `console`) | `console` |
| `TWILIO_ACCOUNT_SID` | `SMS_PROVIDER=twilio` | — |
| `TWILIO_AUTH_TOKEN` | `SMS_PROVIDER=twilio` + delivery webhook signature verification | — |
| `TWILIO_FROM_NUMBER` | `SMS_PROVIDER=twilio` | — |
| `HEIC_TRANSCODER` | optional — `stub` defers, `disabled` dead-letters | `stub` |
| `CRON_SECRET` | scheduled cron | — (cron route 503s if unset) |
| `SUPABASE_SERVICE_ROLE_KEY` | always | — |

---

## 8. Known limitations

- **Email + in-app dispatchers are stubs.** Rows of those channels land in `failed` with reason `channel "email" has no dispatcher yet`. The queue still records them — when an email provider is wired, just add a `dispatchEmail` branch.
- **No per-customer rate-limit on the worker.** A bad template generating 1000 rows for one customer will send all 1000. Future enhancement: a per-customer max-per-hour cap inside `dispatchRow` before invoking the provider.
- **No provider latency metric.** The admin UI shows counts and recent failures but not p50/p99 send latency. Add when traffic justifies the panel.
- **No webhook callback for SMS delivery status.** Twilio's status webhook (`status=delivered/failed/undelivered`) could update the row post-fact. Today the worker considers `200 OK` from Twilio's API as success — a number off-net would still log as sent.
- **HEIC / HEIF photos are not normalised.** The portal accepts and stores them; older browsers won't render them. A Storage trigger that re-encodes to JPEG would close the gap.

---

**Last updated:** 2026-05-14 (phase 12 — SMS adapter + dispatch worker + monitoring UI)
