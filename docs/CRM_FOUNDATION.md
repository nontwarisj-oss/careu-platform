# CareU OPS Platform — CRM Foundation

> **Status:** **foundation tables only**. The schema is in place to support future segmentation, VIP tiers, LINE CRM, and marketing automation. No automation, no broadcast, no scoring engine yet — those are deliberately deferred.

---

## 1. Why a CRM layer

The platform already has:
- `public.customers` — name, phone, branch_id, email/address, customer_tier (from `20260531`).
- `public.customer_line_links` — LINE follower pairing.
- `public.line_message_log` — every send attempt.

This phase adds the missing scaffolding:
- Tags (textual labels admins attach to a customer for segmentation).
- Notes (per-customer free-form notes scoped by branch).
- Activity (append-only event log per customer).
- Channels (generalises beyond LINE — phone / email / web / "other").

Together with the existing tables, every future CRM feature (VIP perks at checkout, monthly newsletter, no-show win-back) reads from this layer.

---

## 2. Schema

All five tables created in [`20260534_public_website_and_crm_foundation.sql`](../supabase/migrations/20260534_public_website_and_crm_foundation.sql).

### 2.1 `public.customer_tags`

```
id           uuid pk
customer_id  uuid → public.customers(id) on delete cascade
tag          text   -- free-form, unique per (customer_id, lower(tag))
created_at   timestamptz
created_by   uuid
```

Unique index on `(customer_id, lower(tag))` makes "vip-2026" and "VIP-2026" collapse to one tag.

### 2.2 `public.customer_notes`

```
id           uuid pk
customer_id  uuid → public.customers(id) on delete cascade
branch_id    text                                   -- where the note was written
body         text not null
created_at   timestamptz
created_by   uuid
```

Branch-scoped via the `branch_id` column. Front-staff can add notes; only owner / HQ / branch_manager can read across branches.

### 2.3 `public.customer_activity`

Append-only event log. Every CRM event lands here:

```
id           uuid pk
customer_id  uuid → public.customers(id) on delete set null   -- nullable: anon events allowed
branch_id    text
kind         text not null                       -- 'quote_submitted', 'tag_added', 'message_sent', …
payload      jsonb default '{}'
created_at   timestamptz
created_by   uuid
```

`kind` is intentionally `text` (no CHECK constraint) so future writers don't need a migration for each new event. The current writers:

| Writer | `kind` |
|---|---|
| `/api/public/quote` | `quote_submitted` |
| Future: order create, payment update, status change, message send | various |

### 2.4 `public.customer_channels`

Generalised contact channels:

```
id            uuid pk
customer_id   uuid → public.customers(id) on delete cascade
channel_type  text  -- 'phone' | 'email' | 'line' | 'web' | 'other'
channel_id    text  -- the actual phone / email / line_user_id / URL
branch_id     text
verified_at   timestamptz   -- set when we've confirmed the channel works
notes         text
created_at    timestamptz
created_by    uuid
```

Unique on `(customer_id, channel_type, channel_id)`. `customer_line_links` remains the authoritative LINE link table; this generalises to other channels.

### 2.5 `public.quote_requests`

The inbox for the public `/quote` form. Anon INSERT allowed; authenticated reads scoped by RLS.

```
id                   uuid pk
customer_name        text     -- as the customer typed it
customer_phone       text     -- normalised before insert
customer_email       text
contact_method       text     -- 'phone'|'line'|'email'|'any'
branch_code          text     -- selected branch slug; nullable
service_category     text
notes                text
photos               jsonb    -- array of URL strings, default []
status               text     -- 'new'|'contacted'|'quoted'|'declined'|'converted'
linked_customer_id   uuid     -- set when admin pairs with a real customers row
linked_at            timestamptz
linked_by            uuid
internal_notes       text
created_at           timestamptz
updated_at           timestamptz
```

---

## 3. RLS policies

| Table | owner / hq_admin | branch_manager | front_staff | technician | anon |
|---|---|---|---|---|---|
| `customer_tags` | full | full (customer in own branch) | full (customer in own branch) | ❌ | ❌ |
| `customer_notes` | full | full (branch_id matches own) | full (branch_id matches own) | ❌ | ❌ |
| `customer_activity` | full | read (own branch) | read (own branch) | read (own branch) | ❌ |
| `customer_channels` | full | full (customer in own branch) | full (customer in own branch) | ❌ | ❌ |
| `quote_requests` | full | full (own branch_code or null) | full (own branch_code or null) | ❌ | INSERT only |

Branch isolation: when the table has its own `branch_id` (notes, activity, quote_requests), the policy joins directly; when it doesn't (tags, channels), the policy joins through `public.customers.branch_id`.

The anon INSERT policy on `quote_requests` is the unusual one — it allows the public form to submit without auth. The route handler caps inserts via rate limiting + per-field validation; the policy ensures only inserts are allowed (no reads from anon).

---

## 4. What this phase does NOT do

By design — these belong to a future CRM / marketing phase:

| Step | Why |
|---|---|
| Segmentation engine | Tags exist; querying them into segments comes with the marketing UI. |
| VIP perk integration | `customer_tier` exists from `20260531`; wiring it to pricing or LINE messages is a future feature. |
| Broadcast scheduler | Out of scope. The LINE webhook + send infrastructure is in place; a job runner that walks segments is not. |
| Auto-CRM workflows | Activity log is the input layer. Triggers / cron consumers come later. |
| Quote-to-order conversion UI | `quote_requests.linked_customer_id` is the contract; the actual triage UI is a future page. |
| Customer-facing portal | `/track` is anonymous lookup, not a logged-in portal. |
| Tag-driven promotions | Tags exist; the pricing engine doesn't read them yet. |

---

## 5. Future readers (entry points)

A future CRM phase plugs into this layer at these seams:

- **Customer detail page** reads `customer_tags`, `customer_notes`, `customer_activity`, `customer_channels` for one customer id.
- **Segmentation query** runs over `customer_tags` + `customer_tier` + `lifetime_spend` to materialise a segment.
- **Activity dashboard** aggregates `customer_activity` by `kind` for "what's happened this week".
- **Broadcast worker** reads a segment, walks `customer_channels`, dispatches messages via the existing LINE + (future) email + SMS clients.
- **Quote triage UI** reads `quote_requests where status = 'new'`, lets the operator link to a `customers` row or create a new one.

---

**Last updated:** 2026-05-14 (CRM foundation tables + RLS shipped)
