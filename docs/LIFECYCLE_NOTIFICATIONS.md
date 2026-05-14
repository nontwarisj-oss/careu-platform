# CareU OPS Platform — Lifecycle Notifications

> **Status:** **live**. Order lifecycle events trigger queued SMS + LINE notifications through the dispatch worker. Customer preferences gate the queue. Server-side audit + per-attempt telemetry are wired.

---

## 1. The picture

```
   ┌──────────────────────┐
   │ OPS UI / cron        │
   │ (intake, status,     │
   │  payment, overdue)   │
   └──────────┬───────────┘
              │ POST /api/internal/lifecycle-event
              ▼
   ┌──────────────────────┐    customer_notification_preferences
   │ lib/lifecycleNotifier│◄───┘
   │  • load order + cust │    customer_line_links (LINE address)
   │  • check prefs       │◄───┘
   │  • dedup (6h window) │
   │  • render templates  │
   │  • enqueue           │
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │ customer_notifications│ (queue — one row per intent)
   └──────────┬───────────┘
              │ /api/cron/dispatch-worker  /api/admin/dispatch/run
              ▼
   ┌──────────────────────┐
   │ runDispatchTick      │
   │  • SMS via sendSms   │
   │  • LINE via push     │
   │  • backoff + retry   │
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │ notification_dispatch│ (telemetry — one row per attempt)
   │      _log             │
   └──────────────────────┘
              │
              ▼ aggregated in /admin/dispatch
            (success rate, latency p50/p95, retry depth, trend)
```

---

## 2. Lifecycle events

| Event | Fired from | Trigger condition |
|---|---|---|
| `order_created` | `components/SmartOrderForm.tsx` | After `createSmartOrder` returns ok |
| `repair_started` | `app/orders/page.tsx` | Status change → `in-progress` |
| `ready_for_pickup` | `app/orders/page.tsx` | Status change → `ready-for-pickup` |
| `order_completed` | `app/orders/page.tsx` | Status change → `completed` |
| `payment_received` | `app/orders/[id]/document/page.tsx` | Payment change → `paid` |
| `overdue_pickup` | `/api/cron/overdue-pickup-sweep` | `ready-for-pickup` AND updated_at ≤ now − 2 days |

Each trigger calls `triggerLifecycleEvent(event, orderId)` (a thin wrapper around `POST /api/internal/lifecycle-event`). The endpoint is server-only, role-gated (any signed-in operator), and branch-scoped via `requireBranchAccess`.

`qc_started` from the spec is intentionally not wired — the OPS app has no QC-specific status today; the in-progress event already covers "we started working". Adding QC as a separate event would change the OPS UI, which Phase 13 explicitly prohibits.

---

## 3. Templates

`lib/notificationTemplates.ts` is the renderer. Pure function:

```
renderNotification(ctx) → { sms: string; line: string }
```

- `ctx.kind` selects the per-kind renderer (`order_created`, `repair_started`, …).
- `ctx.branch` injects the brand name + short label + address (sourced from `lib/brandConfig.ts`).
- `ctx.tier` triggers an honorific upgrade ("คุณ" prefix) for gold/platinum/VIP customers.
- `ctx.ref`, `ctx.service`, `ctx.amountOwed`, etc. inject the variables.

The renderer outputs **two** bodies per call:
- `sms` — ≤ 160-char target (one SMS segment when possible).
- `line` — multi-line, polite, no emoji. Has more room for honorifics and footer.

`preferenceFieldFor(kind)` maps each kind to the preference toggle that gates it (`order_status_alerts`, `pickup_reminders`, `payment_alerts`, `promotional`, or `transactional` for OTP). The notifier consults this before enqueuing.

---

## 4. Dedup

```
DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000  // 6 hours
```

Before enqueueing, the notifier checks `customer_notifications` for an identical (customer_id, kind, payload.orderId, channel) within the window. Match → skip. This protects against:

- Operator double-clicking "mark ready".
- Cron sweeping the same overdue order across multiple ticks.
- Status-change toggles that bounce back and forth.

A row in `status='failed'` does NOT count as a dedup hit — failures should be retried via the queue's normal mechanism.

---

## 5. Customer preferences

Migration `20260537` adds `public.customer_notification_preferences`:

| Field | Default | Gates |
|---|---|---|
| `sms_enabled` | true | all SMS |
| `line_enabled` | true | all LINE |
| `email_enabled` | false | all email (no dispatcher yet) |
| `order_status_alerts` | true | `order_created`, `repair_started`, `order_completed` |
| `pickup_reminders` | true | `ready_for_pickup`, `overdue_pickup` |
| `payment_alerts` | true | `payment_received` |
| `promotional` | false | marketing pushes (none yet) |

Routes:
- `GET /api/portal/preferences` — returns row (or defaults).
- `PATCH /api/portal/preferences` — upserts + writes `prefs_changed` row to `customer_activity` with the diff. Rate-limited 20/10 min/IP.
- `/portal/preferences` — Thai-language toggle UI with sectioned channel + kind controls.

The admin view `/admin/customers/[id]` shows the customer's current toggles + whether they've ever touched them.

---

## 6. Dispatch observability

`lib/notificationDispatchWorker.ts::writeDispatchLog` records one row in `notification_dispatch_log` per attempt:

| Column | Purpose |
|---|---|
| `outcome` | `sent` / `failed` / `skipped` |
| `retryable` | did the worker queue this back for retry? |
| `attempt` | 1-based attempt index |
| `latency_ms` | end-to-end provider call duration |
| `provider` | SMS adapter name (`console` / `twilio` / …) — null for LINE |
| `details` | provider-specific (Twilio SID, LINE request id, error code) |
| `reason` | error message when failed |

`/api/admin/dispatch/summary` now returns an `observability` block aggregated over the last 24 h:

- `successRate` — sent / total (%)
- `avgRetryDepth` — average attempt index for failures
- `providerLatencyMs.p50` / `.p95` — over successful sends
- `deadLetterTrend` — hourly buckets (sent vs failed)
- `byChannel` — same breakdown split by SMS / LINE / email / in_app

The `/admin/dispatch` page renders the new Observability panel inline, with a 24-bucket trend strip.

---

## 7. Audit trail

Every state-changing event writes an audit row. No identity-relevant change is silent.

| Event | Audit table | Action / Kind |
|---|---|---|
| Lifecycle notification enqueued | `order_audit_log` | `lifecycle_notified` (before=event, after=JSON outcome array) |
| Preference change | `customer_activity` | `prefs_changed` (payload includes the diff) |
| Phone change (Phase 12) | `customer_activity` | `phone_change_requested` / `phone_changed` |
| Notification dispatch attempt | `notification_dispatch_log` | one row per attempt |

The lifecycle audit row makes "did we tell the customer?" answerable from a single SQL query against `order_audit_log`.

---

## 8. Cron

The new `/api/cron/overdue-pickup-sweep` endpoint:

- Auth: `Authorization: Bearer ${CRON_SECRET}` (same as the other cron routes).
- Selects up to 50 orders in `status='ready-for-pickup'` whose `updated_at` is at least 2 days old (the grace period).
- Calls `notifyLifecycleEvent('overdue_pickup', orderId)` for each.
- Idempotent — the notifier's 6-h dedup window prevents re-firing within the same cycle.

Recommended schedule: once a day at midday (so customers see the reminder during business hours).

---

## 9. Realtime portal refresh

`lib/usePortalRefresh.ts` is a visibility-aware polling hook used by `/portal/orders/[id]`:

- Default 30 s interval.
- Pauses when `document.visibilityState !== 'visible'` (hidden tabs do nothing).
- Skips overlapping requests (a slow fetch never triggers a stacked one).
- Refresh-on-visibility-change so a backgrounded tab catches up immediately when the user returns.

The hook is intentionally polling instead of Supabase realtime — the portal's traffic profile is "phone session of < 2 minutes", and per-session WebSocket slots would scale poorly with thousands of customers. The dispatch worker is itself polled by cron; the customer's view doesn't need lower latency.

---

## 10. HEIC + mobile uploads

`lib/uploadClient.ts::compressImageIfBeneficial` now:

- Uses `createImageBitmap(file, { imageOrientation: "from-image" })` — automatically applies EXIF orientation, so iPhone portraits no longer arrive sideways.
- For HEIC/HEIF: tries to decode (iOS Safari succeeds, Android Chrome fails). On success, re-encodes to JPEG. On failure, uploads the raw bytes and sets `needsTranscoding: true` so a future Storage trigger can convert.
- For GIF: passes through unchanged (re-encode would lose animation).
- For PNG/JPEG: re-encodes only when downscaling helps or the original > 1.2 MB.

The `UploadResult.needsTranscoding` flag is surfaced to callers; a future server-side worker can read `order_attachments` rows for HEIC-bytes-with-no-JPEG-sibling and transcode.

---

## 11. Branch isolation

| Surface | Auth | Branch scope |
|---|---|---|
| `/api/internal/lifecycle-event` | `requireRole([…operators…])` + `requireBranchAccess(order.branch_id)` | enforced |
| `/api/cron/overdue-pickup-sweep` | `Bearer CRON_SECRET` | n/a — machine endpoint, no role |
| `/api/portal/preferences` | customer cookie | per-customer (own data only) |
| `/api/portal/activity` | customer cookie | per-customer |
| `/api/admin/customers/[id]` | `requireRole([owner, hq_admin, branch_manager, front_staff])` + `requireBranchAccess(customer.branch_id)` | enforced |
| `/admin/dispatch` | `requireRole([owner, hq_admin])` | n/a — central view |

---

**Last updated:** 2026-05-14 (phase 13 — lifecycle triggers + preferences + observability)
