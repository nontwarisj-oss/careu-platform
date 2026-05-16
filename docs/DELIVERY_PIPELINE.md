# CareU OPS Platform — Delivery Pipeline

> **Status:** permanent reference. The end-to-end path a message takes from enqueue to confirmed delivery, and how every step is observable.

---

## 1. The pipeline

```
enqueueNotification()                 → customer_notifications (status='queued')
        │
   dispatch-worker cron                → status='sending' → provider API call
        │                                 → status='sent' + provider_message_id
        ▼
   provider (Twilio / Resend / LINE)
        │
   delivery webhook                    → /api/webhooks/{twilio-status,email-status}
        │                                 → status='delivered' | 'failed'
        ▼
   communication_events                 → opened / clicked / bounced
```

Failures re-enter via `retry-worker` with exponential backoff; terminal failures land `dead_letter`.

---

## 2. Webhook trust (Phase 25)

Every inbound provider callback passes [`lib/webhookAudit.ts`](../lib/webhookAudit.ts):

| Guard | Mechanism |
|---|---|
| **Signature** | Twilio HMAC-SHA1 (`TWILIO_AUTH_TOKEN`), Resend Svix HMAC-SHA256 (`RESEND_WEBHOOK_SECRET`), LINE HMAC-SHA256 (`LINE_CHANNEL_SECRET`). Constant-time compare. |
| **Replay** | `webhook_audit_log` unique index on `(provider, event_id)` for accepted rows. A re-delivered callback is `200`-acked but **not** reprocessed. |
| **Malformed** | Unparseable body → `400`, audited `outcome='malformed'`. |
| **Idempotency** | Queue status is monotonic-rank; `communication_events` dedups on `(provider, provider_event_id)`. |
| **Audit** | One `webhook_audit_log` row per call: provider, event_id, signature verdict, outcome, detail. |

Event-id keys: Twilio `<sid>:<status>`, Resend `svix-id` header, LINE `webhookEventId` (or body hash).

**Metrics** — `webhookMetrics(24h)` counts accepted / replay / invalid_signature / malformed / error. Surfaced on `/admin/system/workers` (Webhook trust) + the smoke test.

---

## 3. Delivery confirmation

| Channel | Confirmed by |
|---|---|
| SMS | Twilio status webhook → `customer_notifications.status` + `broadcast_metrics_daily`. |
| Email | Resend webhook → `communication_events` + queue status + `campaign_funnel_metrics`; operator-alert emails confirmed via `alert_deliveries.provider_message_id`. |
| LINE | Push request id captured; LINE has no delivery receipt — "delivered" inferred at send. |

---

## 4. The audit trail

[`lib/deliveryTimeline.ts`](../lib/deliveryTimeline.ts)`::getNotificationTimeline` merges `customer_notifications` milestones + `notification_dispatch_log` attempts + `communication_events` into one ordered trail:

`queued → dispatched → provider_accepted → delivered → opened → clicked → failed → bounced → retried → escalated → cancelled`

Reachable from:
- **Customer detail** (`/admin/customers/[id]`) — a **trail** toggle per notification.
- **Delivery trace explorer** (`/admin/system/delivery-trace`) — search by provider id / customer / phone / status / campaign, then expand.
- **Campaign job page** — links into the trace explorer filtered by `broadcastJobId`.
- **Incident export** — the timeline is bundled into the incident package.

---

## 5. Provider reliability metrics

[`lib/providerMetrics.ts`](../lib/providerMetrics.ts)`::computeProviderMetrics` — per provider over a window: send count, success %, retry rate, bounce rate, click rate, callback latency, a coarse uptime estimate (fraction of hourly buckets with a successful send). Plus per-branch delivery rollup. Surfaced on `/admin/system/workers`.

---

## 6. Incident export

[`lib/incidentExport.ts`](../lib/incidentExport.ts)`::buildIncidentPackage` bundles one incident — timeline + dispatch log + provider webhook payloads + retry history (notification incident), or alert + escalation chain + cron heartbeats (alert incident) — as JSON or markdown via `GET /api/admin/system/incident-export`.

---

## 7. Webhook retry queue (Phase 26)

A provider callback that verifies + parses but then throws during processing is captured into `webhook_retry_queue` as a normalized `DeliveryReceipt` and 200-acked — the platform owns recovery instead of relying on the provider's retry budget. The `webhook-retry` cron (every ~10 min) re-applies it with exponential backoff; 6 failed attempts → `dead_letter`. See [WEBHOOK_SECURITY.md](./WEBHOOK_SECURITY.md).

## 8. Provider-agnostic delivery receipt (Phase 26)

`lib/deliveryReceipt.ts` normalizes every provider callback to one `DeliveryReceipt` shape and applies it idempotently via `applyDeliveryReceipt()`. This is both the retry-queue replay unit and the future-safe ingestion layer — when LINE ships delivery receipts, only `normalizeLineReceipt` needs filling in.

## 9. Multi-target LINE escalation (Phase 26)

`routeAlert` fans an alert out to **every** resolved LINE target (multiple operators + HQ + branch escalation groups), not just the first. Targets come from `escalation_recipients` ∪ `alert_preferences.line_target` ∪ `ALERT_LINE_TARGET`; each push is one `alert_deliveries` row. Dedup + cooldown unchanged.

---

**Last updated:** 2026-05-15 (phase 26 — communication reliability completion)
