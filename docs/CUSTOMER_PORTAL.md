# CareU OPS Platform — Customer Portal

> **Status:** **customer-communication capable**. Phone+OTP sign-in, read-only order history with audit timeline + signed-URL photo gallery, profile self-edit including a re-verifying phone-change flow. The notification queue is now drained by a real dispatch worker (SMS + LINE). No marketing automation, no broadcast engine, no payments.

---

## 1. Why a portal

The public website (previous phase) supported anonymous lookup via `/track` (Job ID + phone). The portal is the next step — a persistent customer session that gives a returning customer one URL to:

- See every order they've ever placed across every branch they've visited.
- Open any past receipt without re-entering a Job ID.
- Maintain their own name + email.
- Upload photos for a current job or quote without proxying through the platform's bandwidth.

The portal is **separate from the OPS auth**. Operators sign in via LINE login → `careu_session`. Customers sign in via phone+OTP → `careu_customer_session`. The two cookies coexist; neither can satisfy the other's routes.

---

## 2. Routes

| URL | File | Auth | Purpose |
|---|---|---|---|
| `/portal` | `app/(public)/portal/page.tsx` | required (redirects to `/portal/signin` otherwise) | Dashboard — stats + nav |
| `/portal/signin` | `app/(public)/portal/signin/page.tsx` | n/a | Phone → OTP flow |
| `/portal/orders` | `app/(public)/portal/orders/page.tsx` | required | All-orders list |
| `/portal/orders/[id]` | `app/(public)/portal/orders/[id]/page.tsx` | required + customer_id match | Customer-safe order detail + timeline + photo gallery |
| `/portal/profile` | `app/(public)/portal/profile/page.tsx` | required | Self-edit name + email |
| `/portal/phone-change` | `app/(public)/portal/phone-change/page.tsx` | required | OTP-verified phone change |
| `/portal/preferences` | `app/(public)/portal/preferences/page.tsx` | required | Notification channel + kind toggles |
| `/portal/history` | `app/(public)/portal/history/page.tsx` | required | Completed / ready / cancelled orders |

`/portal/*` is included in the `PUBLIC_PREFIXES` list (lib/authContext.tsx) so the OPS strict-mode redirect leaves it alone. Crawlers are blocked by `robots.ts` because the portal is a private surface.

---

## 3. Authentication

### 3.1 Sign-in flow

```
[customer enters phone] ──► POST /api/portal/auth/request-otp
                                   │
                                   ▼
                       customerOtp.issueCustomerOtp(phone)
                         • normalises phone
                         • invalidates older un-consumed codes
                         • inserts customer_otp_codes (code_hash, expires_at)
                         • emits console.info (no SMS yet)
                         • returns devCode in non-production
                                   ▼
[customer enters 6-digit code] ──► POST /api/portal/auth/verify-otp
                                   │
                                   ▼
                       customerOtp.verifyCustomerOtp(phone, code)
                         • hashes input + compares constant-time
                         • dev-mode accepts universal "123456"
                         • caps attempts at 5
                         • stamps consumed_at on success
                                   ▼
                       identityResolver.findOrCreateByPhone(phone)
                                   ▼
                       customerSession.encodeCustomerSession({ ... })
                       customerSession.setCustomerSessionCookie(value)
                                   ▼
                       crmProgressionService.refreshCustomerProgression(id)
                                   ▼
                       returns { ok: true, customer }
```

`careu_customer_session` is HMAC-signed using the same `SESSION_SECRET` as the OPS cookie. Payload: `{ customerId, phone, name, iat, exp }`. TTL 30 days. The cookie name and payload shape are different from the OPS one so they cannot be confused server-side.

### 3.2 SMS provider (live)

`lib/customerOtp.ts::issueCustomerOtp` hands the code off to `lib/smsProvider.ts::sendSms` — a thin adapter that picks a provider based on `SMS_PROVIDER` env (default `console` for dev, `twilio` for production). The dispatch worker (§9) uses the same `sendSms` for queued SMS rows so OTP and async notifications share one outbound surface. Universal dev code `123456` ALWAYS works in non-production for testing — see [SMS_AND_DISPATCH.md](./SMS_AND_DISPATCH.md).

### 3.3 Security limits

| Surface | Limit |
|---|---|
| `request-otp` | 5 requests / 10 min / IP. Code TTL 5 min. Older un-consumed codes for the same phone are invalidated on each issue. |
| `verify-otp` | 20 attempts / 10 min / IP. Per-code attempt cap 5. After cap, the code is dead even if the right value is sent later. |
| `me` | None — cheap read of the cookie + customers row. |

---

## 4. Portal data surface

### 4.1 What the customer sees

| Field | Source | Origin column |
|---|---|---|
| Name | `customers.name` | `customers.name` |
| Phone (read-only) | `customers.phone` | `customers.phone` |
| Email | `customers.email` | `customers.email` (treats `'N/A'` as blank) |
| Tier badge | `customers.customer_tier` | from `customerTierService.refreshCustomerTier` |
| Lifecycle stage | `customers.lifecycle_stage` | from `crmProgressionService.refreshCustomerProgression` |
| Last visit | `customers.last_visit_at` | from the customer-tier writer |
| Total orders | `customers.total_orders` | from the customer-tier writer |
| Lifetime spend | `customers.lifetime_spend` | from the customer-tier writer |
| Order list | `orders` filtered by `customer_id` | per-order |
| Order detail | `orders` row + branch label | per-order |

### 4.2 What the customer does NOT see

Hand-picked exclusions on every portal route:

- `orders.labor_cost`, `orders.material_cost`
- `orders.assigned_technician_id`, `orders.tech`
- `orders.notes` (free-form internal notes)
- Any payroll, audit, recovery, or admin column
- Other customers' branch slugs
- Internal pricing breakdowns beyond what the receipt subtotal / discount / urgent fee already imply

The order list and detail routes (`app/api/portal/orders/route.ts`, `app/api/portal/orders/[id]/route.ts`) build the response shape explicitly — no SELECT *. The `customer_id` match is hard-enforced; wrong-owner attempts get the same 404 as a missing id (no information leak).

---

## 5. Upload pipeline

See [UPLOADS.md](./UPLOADS.md) for the full contract. Summary:

- `lib/uploadService.ts::issueUploadUrl` mints a signed PUT URL against the `customer-uploads` Supabase Storage bucket (private, no public reads).
- Folder layout: `<branch-code>/{customers|orders|quotes}/<id>/<uuid>.<ext>`.
- Two routes mint URLs:
  - `POST /api/portal/upload-url` — authenticated customer, scope forced to their own customer/order.
  - `POST /api/public/upload-url` — anonymous, scope always `quote`, rate-limited 10/hour/IP.
- Allowed MIME: image/jpeg, png, webp, heic, heif. Max declared size 8 MB. Signed URL TTL 5 min.
- Read access: `lib/uploadService.ts::issueReadUrl` mints short-lived (60 s) signed GET URLs for the receipt viewer + admin triage tools.

---

## 6. CRM progression integration

Every successful sign-in calls `crmProgressionService.refreshCustomerProgression(customerId)` so the customer's `lifecycle_stage` + `retention_score` reflect the new login. The portal badge shows the resulting stage; future automation reads these columns to schedule reactivation reminders without re-computing at the call site.

Lifecycle stages (full thresholds in `PROGRESSION_THRESHOLDS`):

| Stage | Trigger |
|---|---|
| `new` | First order or recent activity with < 2 orders |
| `active` | ≥ 2 orders, last visit within 90 days |
| `reactivated` | Previously churned / dormant, recent visit returned them |
| `at_risk` | Last visit 90–180 days ago |
| `dormant` | Last visit 180–365 days ago |
| `churned` | Last visit > 365 days ago OR zero orders since first sighting |

`retention_score` is a weighted combination of recency (50 %) + frequency (30 %) + spend (20 %) — pure function in `calculateRetentionScore`.

---

## 7. Notification queue integration

`lib/notificationService.ts::enqueueNotification(spec)` writes a `customer_notifications` row; `lib/notificationDispatchWorker.ts::runDispatchTick` drains it. Per-row state machine: `queued → sending → (sent | failed-retryable | dead)`. SMS rows route through `sendSms`; LINE rows route through `pushTextMessage`; email/in-app remain manual surfaces today. See [SMS_AND_DISPATCH.md](./SMS_AND_DISPATCH.md) for the operator runbook + cron wiring. Portal sign-in still does not enqueue a "welcome back" — that's a marketing-automation phase decision, not infrastructure.

## 8. Phone-change flow

`/portal/phone-change` is the customer's way to change the phone number tied to their account without admin intervention.

```
[customer enters new phone] ──► POST /api/portal/phone-change/request
                                  │
                                  ▼  rate-limit 10/hr/IP + 3/hr/customer
                                  ▼  conflict check vs other customers
                                  ▼  insert phone_change_requests row
                                  ▼  hash code with rowId as salt
                                  ▼  sendSms via SMS provider (or console)
                                  ▼  audit: kind='phone_change_requested'
                                  ▼
[customer enters 6-digit code] ──► POST /api/portal/phone-change/verify
                                  ▼  expiry check + 5-attempt cap
                                  ▼  RE-CHECK conflict at commit time
                                  ▼  UPDATE customers.phone + normalized_phone
                                  ▼  stamp phone_change_requests.verified_at
                                  ▼  audit: kind='phone_changed'
                                  ▼  redirect → /portal/profile (cookie unchanged)
```

The session cookie carries `customerId`, not `phone`, so the existing session stays valid through the change — no re-login. Anti-takeover is enforced two ways: a unique partial index on `phone_change_requests.new_phone WHERE verified_at IS NULL AND cancelled_at IS NULL` prevents two customers from claiming the same new number in parallel; the verify step re-checks the conflict at commit time in case a race slipped through. Both phone-change events land in `customer_activity` as audit rows.

---

## 9. Order timeline + photo gallery

The order-detail page (`/portal/orders/[id]`) embeds two extra sections beyond the price summary:

- **ประวัติงาน (timeline)** — reads a customer-safe slice of `order_audit_log` via `GET /api/portal/orders/[id]/timeline`. Only four actions surface in the portal: `created`, `status_changed`, `payment_changed`, `cancelled`. Internal-only actions (`cost_updated`, `sync_pushed`, `sync_failed`, `assigned`, `receipt_regenerated`) are filtered server-side. A synthetic "created" event is injected for legacy orders that predate the audit log.
- **รูปประกอบงาน (photo gallery)** — reads `order_attachments` via `GET /api/portal/orders/[id]/photos`. Each row's `file_url` is a Storage path; the route mints a 5-minute signed READ URL per row (via `lib/uploadService.ts::issueReadUrl`). Only `image/*` MIME types surface; PDFs / videos are operator-only. The grid is mobile-first (3 cols < 640 px, 4 cols above) with tap-to-zoom.

Both routes hard-check `orders.customer_id === session.customerId` (same 404 enumeration-resistant pattern as the detail route — wrong-owner gets the same response as a missing id).

## 10. Upload client helper

`lib/uploadClient.ts::uploadFile` is the browser-side upload helper. Three benefits over a raw `<input type="file">` + fetch:

1. **Compression** — re-encodes large photos to JPEG capped at 1920 px (longer side) at 82 % quality. HEIC/HEIF/GIF are passed through unchanged (Canvas can't decode them in most browsers). PNG screenshots that would be larger after re-encode are kept as the original.
2. **Progress** — XHR-based with per-byte `onProgress` callbacks. The portal can render a `<progress>` bar instead of a frozen spinner.
3. **Retry** — exponential backoff (600 ms → 1.8 s → 5.4 s) on status 0/408/429/5xx. Non-retryable failures (400 MIME mismatch, 403 expired URL) bail immediately.

Scope is one of `quote` (anonymous, anti-spam rate-limited 10/hr/IP), `customer` (portal session, branch resolved server-side), or `order` (portal session + customer_id check on the order). The wiring into a specific portal page is left for a follow-up phase — the helper exists so future "upload a photo for this job" surfaces don't reinvent retry/compression/progress.

## 11. Known limitations

- **No portal "pickup notification preferences" toggle** — the orchestrator in `lib/lineDelivery.ts` already respects `customer_line_links.notify_*` flags, but the portal doesn't surface the toggle yet.
- **Gallery is read-only today** — `order_attachments` has no writer in the portal; intake / admin add photos. The portal gallery degrades gracefully (empty section hidden) when no photos exist.
- **No portal-side broadcast / push** — by design (deferred). Notifications queue + dispatcher exist for transactional sends; broadcast / campaign segmentation is a later phase.
- **No language switcher** — Thai-only on the portal.
- **No real-time order updates** — pages fetch on mount; a customer who has the portal open will not see status changes until they reload. WebSockets / SSE is a future enhancement.
- **No customer-side merge UI** — duplicate customer rows (same phone in two branches) still need admin intervention.
- **No mobile auto-fill of OTP** — the input is plain text. iOS / Android auto-fill needs `autocomplete="one-time-code"` + a sender hash in the SMS body; both are a marketing concern, not infrastructure.
- **Phone-change rate limit is per-IP + per-customer, not per-new-phone** — a malicious user could spam OTP codes at one specific target phone from many accounts. The anti-takeover unique index prevents *claim*; the spam concern is one we'll revisit with the SMS provider's own abuse signals.

---

**Last updated:** 2026-05-14 (phase 12 — SMS provider, dispatch worker, phone-change flow, portal timeline + gallery, upload client)
