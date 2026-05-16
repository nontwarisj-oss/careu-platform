# CareU OPS Platform — Webhook Security & Reliability

> **Status:** permanent reference. Every inbound provider callback (Twilio / Resend / LINE) passes this trust + recovery pipeline.

---

## 1. Trust pipeline

Every webhook route runs the same gate order:

```
1. signature  → HMAC verify (constant-time). Fail → audit 'invalid_signature', reject.
2. parse      → unparseable body → audit 'malformed', reject.
3. replay     → (provider, event_id) already accepted? → audit 'replay', 200-ack, do NOT reprocess.
4. process    → inside try/catch.
5a. success   → audit 'accepted'.
5b. throw     → enqueue webhook_retry_queue, audit 'error', 200-ack (we own recovery now).
```

| Provider | Signature | Secret | Event-id key |
|---|---|---|---|
| Twilio | HMAC-SHA1 | `TWILIO_AUTH_TOKEN` | `<MessageSid>:<MessageStatus>` |
| Resend | Svix HMAC-SHA256 | `RESEND_WEBHOOK_SECRET` | `svix-id` header |
| LINE | HMAC-SHA256 | `LINE_CHANNEL_SECRET` | `webhookEventId` / body hash |

All recorded in `webhook_audit_log` (Phase 25). Replay protection: the unique index on `(provider, event_id)` for accepted rows.

---

## 2. Retry queue (Phase 26)

A callback that verifies + parses but then **throws during processing** is no longer at the mercy of the provider's limited retry budget. The route captures a normalized `DeliveryReceipt` into `webhook_retry_queue` and 200-acks.

`webhook-retry` cron (every ~10 min) drains the queue:

- Re-applies the receipt via `applyDeliveryReceipt()` — idempotent, forward-only.
- Success → `status='succeeded'`.
- Failure → exponential backoff (2min × 4^attempt, capped 6h), `attempts++`.
- `attempts ≥ max_attempts` (6) → `status='dead_letter'` with a terminal reason.

---

## 3. Provider-agnostic delivery receipt

[`lib/deliveryReceipt.ts`](../lib/deliveryReceipt.ts) is the normalization layer:

- `normalizeTwilioReceipt` / `normalizeResendReceipt` / `normalizeLineReceipt` → a uniform `DeliveryReceipt { provider, providerMessageId, notificationId, status, channel, eventId, branchId, occurredAt, raw }`.
- `applyDeliveryReceipt(receipt)` turns one into DB state using only existing idempotent helpers (`maybeApplyDeliveryStatus`, `recordCommunicationEvent`, `maybeRecordBroadcastDelivery`, `confirmAlertEmailDelivery`).

`normalizeLineReceipt` is a **placeholder** — LINE has no per-message delivery receipt today; when it ships, only that function needs filling in.

---

## 4. Dead-letter explorer + replay

`/admin/system/webhook-retries` (owner / HQ / branch_manager-read) — lists the retry queue by status / provider, shows retry history + terminal reason + the normalized payload. owner / HQ can **Replay** any row (including dead-letter); replays are audited to `cron_heartbeat_logs` and rate-limited (30 / 10 min / IP).

---

## 5. Reliability metrics

`/admin/system/workers` → **Webhook reliability** — `webhook_retry_queue` pending / retrying / dead-letter / recovered-24h. **Webhook trust** — `webhook_audit_log` accepted / replay / invalid-signature / malformed / error.

---

## 6. Env reference

| Env | Purpose |
|---|---|
| `TWILIO_AUTH_TOKEN` | Twilio webhook signature. |
| `RESEND_WEBHOOK_SECRET` | Resend (Svix) webhook signature. |
| `LINE_CHANNEL_SECRET` | LINE webhook signature. |
| `CRON_SECRET` | `webhook-retry` cron auth. |

---

**Last updated:** 2026-05-15 (phase 26 — communication reliability completion)
