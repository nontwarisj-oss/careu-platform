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
queued ──► sending ──► sent       (success)
                  └──► queued     (transient failure; send_after += backoff)
                  └──► failed     (non-retryable OR attempts ≥ MAX_ATTEMPTS)
```

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

---

## 5. Monitoring UI

`/admin/dispatch` (file: `app/admin/dispatch/page.tsx`) — Owner / HQ only. Surfaces:

- **Counts by status** — queued / sending / sent / failed / skipped.
- **Recent failures (25)** — channel, kind, attempts, error_reason, branch. Filter for patterns at a glance.
- **Pending preview (25)** — what the next tick will pick up, ordered by `send_after`.
- **Manual "รัน tick (25)"** — calls `/api/admin/dispatch/run`. Result expanded inline with per-row outcomes.
- **SMS provider** — current value of `SMS_PROVIDER` env. Confirms which adapter is wired without SSH.

The page is the operator's primary view onto async customer comms — sibling to `/admin/recovery` (which monitors `sync_failures`).

---

## 6. Database

Migration `20260536_phone_change_and_dispatch.sql`:

- `phone_change_requests` table (id, customer_id, current_phone, new_phone, code_hash, expires_at, verified_at, cancelled_at, attempts, created_at).
- Unique partial index `phone_change_requests_new_phone_pending_uniq ON (new_phone) WHERE verified_at IS NULL AND cancelled_at IS NULL` — prevents two concurrent claims on the same new number.
- `customer_notifications_channel_status_idx ON (channel, status)` — speeds the worker's per-channel queue scan.
- `customer_notifications_failed_idx ON (created_at DESC) WHERE status = 'failed'` — speeds the dispatch UI's recent-failures query.

RLS is off on `phone_change_requests` (server-only writes via service role, same pattern as `customer_otp_codes`).

---

## 7. Env vars

| Var | Required when | Default |
|---|---|---|
| `SMS_PROVIDER` | always (defaults to `console`) | `console` |
| `TWILIO_ACCOUNT_SID` | `SMS_PROVIDER=twilio` | — |
| `TWILIO_AUTH_TOKEN` | `SMS_PROVIDER=twilio` | — |
| `TWILIO_FROM` | `SMS_PROVIDER=twilio` | — |
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
