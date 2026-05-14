# CareU OPS Platform — Customer Portal

> **Status:** **foundation live**. Phone+OTP sign-in, read-only order history, profile self-edit, and an upload pipeline ship in this phase. No marketing automation, no broadcast engine, no payments.

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
| `/portal/orders/[id]` | `app/(public)/portal/orders/[id]/page.tsx` | required + customer_id match | Customer-safe order detail |
| `/portal/profile` | `app/(public)/portal/profile/page.tsx` | required | Self-edit name + email |
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

### 3.2 SMS provider (deferred)

`lib/customerOtp.ts::issueCustomerOtp` currently emits the code via `console.info`. In non-production it's also returned in the `devCode` response so QA flows work. **A future phase plugs in a real provider** (Twilio / Thai SMS aggregator) — the function shape stays identical; only the "send" step changes. Universal dev code `123456` ALWAYS works in non-production for testing.

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

Foundation-phase contract: portal sign-in DOES NOT yet enqueue a "welcome back" notification. The infrastructure is in place — `lib/notificationService.ts::enqueueNotification(spec)` writes a `customer_notifications` row — but the dispatcher worker is intentionally deferred to a marketing-automation phase. Today the queue serves as the API the future engine will consume.

---

## 8. Known limitations

- **No SMS provider** — OTP codes are log-only. Dev code `123456` accepted in non-production. Production needs a real provider integration before launch.
- **No phone-change flow** — `/portal/profile` doesn't expose phone editing. Changing a phone requires admin SQL + re-verification on the new number; a future "verify new phone" flow ships this safely.
- **No portal "pickup notification preferences" toggle** — the orchestrator in `lib/lineDelivery.ts` already respects `customer_line_links.notify_*` flags, but the portal doesn't surface the toggle yet.
- **No avatar / photo gallery on the portal** — upload pipeline works but the portal pages don't yet render the customer's uploaded photos.
- **No portal-side broadcast / push** — by design (deferred). Notifications queue exists; the dispatcher does not.
- **No language switcher** — Thai-only on the portal.
- **No real-time order updates** — pages fetch on mount; a customer who has the portal open will not see status changes until they reload. WebSockets / SSE is a future enhancement.
- **No customer-side merge UI** — duplicate customer rows (same phone in two branches) still need admin intervention.
- **No mobile auto-fill of OTP** — the input is plain text. A future PR can add `autocomplete="one-time-code"` once we have a real SMS provider that ships the code in a sender hash format browsers / iOS recognise.

---

**Last updated:** 2026-05-14 (customer portal foundation + OTP + CRM progression integration)
