# CareU OPS Platform — Customer Identity Model

> **Status:** permanent reference. Every customer-touching surface (orders, LINE OA, sheet sync, receipts) must respect the identity contracts described here.

---

## 1. Why identity matters

The platform has three customer-shaped surfaces that must point at the same person:

| Surface | What it stores | Where it lives |
|---|---|---|
| `public.customers` | name, phone, branch_id, email/address | DB |
| `public.orders` | a denormalised `customer_name` + an optional FK `customer_id` | DB |
| LINE OA follower | `line_user_id`, no real-name guarantee | LINE platform |

If the three drift, customers get:
- LINE messages addressed to the wrong person.
- Loyalty / tier benefits attached to the wrong record.
- Reconciliation gaps when the Google Sheet shows orders the DB doesn't.

The platform's identity model is built around three rules that prevent each failure mode.

---

## 2. Identity rules

### 2.1 Phone is the canonical join key

`customers.normalized_phone` (populated by [`lib/phone.ts::normalizePhone`](../lib/phone.ts)) is the canonical join key between the storefront flow and any external system. Two phones that normalise the same represent the same person.

The `normalized_phone` column is indexed but NOT unique — historical imports left duplicates that have to be reconciled by hand rather than blocked. The reconcile job (§5) surfaces them.

### 2.2 One LINE user → one active customer link

`public.customer_line_links.line_user_id` is unique (DB index `customer_line_links_line_user_id_uniq`). The active link's `customer_id` is the customer the LINE OA sees as "this LINE follower". Rules:

- A follow event upserts the row with `customer_id=NULL`. The webhook NEVER guesses a customer.
- Admin pairs `customer_id` via `/admin/customer-line` (see §4).
- Unlinking sets `customer_id=NULL` again; the follow row stays so the consent timestamp is preserved.
- One customer can have multiple LINE links (family sharing). The platform doesn't block this — but the linker UI surfaces existing links for the same customer so the admin can decide.

### 2.3 Branch ownership

`public.customers.branch_id` is the customer's branch of record (text slug matching `branches.code`). A customer can place orders at other branches; the row stays at its origin. RLS scopes branch_manager / front_staff reads to their branch + global rows (`branch_id IS NULL`). Owner / hq_admin see every customer.

---

## 3. The flow end-to-end

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Customer drops in at a branch                            │
│    Front-staff searches by phone in SmartOrderForm.         │
│    No match? Front-staff creates a customers row.           │
│    Output: customers row + orders row, both with phone +    │
│            branch_id set.                                   │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Order is written, audit row + Sheet sync run             │
│    The Front_Desk sync uses the same customer_name + phone  │
│    so the accountant's reconciliation is straightforward.   │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Customer scans the OA QR                                 │
│    LINE delivers a `follow` event to /api/line/webhook.     │
│    The webhook upserts customer_line_links with             │
│    customer_id=NULL + consented_at=now().                   │
│    NO message goes out yet — the orchestrator looks up by   │
│    customer_id and finds nothing.                           │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Owner / HQ pairs the LINE user                           │
│    Opens /admin/customer-line → "Unmatched" tab.            │
│    Suggested customers ranked by phone / name / recent      │
│    orders. Admin picks the right one → POST                 │
│    /api/admin/customer-line/link → customer_id is set.      │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Next order_ready / receipt send fires successfully       │
│    lib/lineDelivery.ts looks up by customer_id, finds the   │
│    link, sends the message via the per-branch channel       │
│    config.                                                  │
└─────────────────────────────────────────────────────────────┘
```

A follow that never gets paired stays in `customer_line_links` with `customer_id=NULL`. After 7 days the reconcile job (see §5) enqueues a `reconcile_orphan_link` mismatch into `sync_failures`.

---

## 4. The linker UI (`/admin/customer-line`)

Owner / HQ admin only. Two tabs:

| Tab | What it shows | Actions |
|---|---|---|
| **Unmatched** | `customer_id IS NULL AND ignored_at IS NULL` rows | Match (pair with a customer), Ignore |
| **Linked** | rows with `customer_id` set | Review, Unlink |

**Suggestion engine** ([`lib/customerMatching.ts`](../lib/customerMatching.ts)) runs three sub-searches in parallel for each row the admin opens:

- `findCustomerByPhone(client, phone)` — exact normalised match (score 95).
- `findCustomersByNormalizedName(client, displayName)` — ilike search; exact lower-case match scores 75, prefix 60, substring 50.
- `findRecentlyActiveCustomers(client, days=7)` — customers with orders in the last week (score 30).

Results are deduplicated by `customers.id`. The admin sees the score + reason ("phone match (0812345678) + ordered within 7 days").

**Manual link rules** enforced by `/api/admin/customer-line/link`:
- The target customer must exist (404 otherwise).
- A no-op re-bind to the same customer returns `alreadyLinked: true`.
- Linking always clears `ignored_at` so the row leaves the ignored bucket.

**Unlink** resets `customer_id` to NULL but preserves the follow audit trail in `line_follow_events`.

**Ignore** stamps `ignored_at` + `ignored_by`. Different from unsubscribe — unsubscribe is the customer's choice (set by an `unfollow` webhook event); ignore is the admin's triage state.

---

## 5. Reconcile job (`/admin/recovery` → "Reconcile" tab)

[`lib/reconcile.ts::runReconcileTick`](../lib/reconcile.ts) compares three surfaces in one pass and enqueues divergences as `sync_failures` rows so the existing recovery UI handles them:

| Check | Detects | Enqueued kind | Auto-retry? |
|---|---|---|---|
| Orders vs Sheet | Orders missing from Front_Desk!B | `reconcile_missing_sheet` | ✅ via `syncOrderToSheetCore` |
| Duplicate Sheet rows | Same Job ID appearing 2+ times in column B | `reconcile_duplicate_sheet` | ❌ manual (admin picks the canonical row) |
| Orphan LINE links | `customer_line_links` unlinked + un-ignored 7+ days | `reconcile_orphan_link` | ❌ manual (admin pairs in linker UI) |

**Idempotency.** Reconcile is safe to run repeatedly — it checks for an open `sync_failures` row with the same `(kind, target_id)` before enqueuing, so duplicate enqueues don't happen.

**Scope.**
- Orders are scanned in the last 30 days by default (admin can override 1–90).
- Sheet column B is loaded entirely in one `values.get` call.
- Orphan links use a 7-day threshold against `customer_line_links.created_at`.
- Hard cap of 500 orders per tick — large backlogs need multiple runs (intentional, prevents API rate-limit thrashing).

**Run history.** Every invocation writes a `public.reconcile_runs` row (heartbeat + summary counts) so admins can see "last reconcile: 12m ago • 3 mismatches".

---

## 6. Why reconcile reuses `sync_failures`

Mismatches and sync failures share the same operator surface: "the platform noticed a divergence and an admin needs to act on it". The recovery UI already supports filter / retry / resolve / inspect — reusing it saves a parallel admin surface.

The trade-off is semantic: `sync_failures` historically meant "the platform tried something and it failed". A reconcile entry means "the platform noticed something is off". For the foundation phase the reuse is honest — if reconcile complexity grows (full mismatch metadata, snooze states, custom resolution flows) a dedicated `reconcile_mismatches` table is a clean future migration.

---

## 7. Franchise-safe ownership rules

When a new branch / franchise comes online:

- Their `customers` rows are stamped with the new `branches.code` — RLS scopes their reads automatically.
- Their `customer_line_links` rows show up in the central `/admin/customer-line` view (admin-only). Branch-manager has read-only access to their branch's links via the existing `customer_line_links_branch_read` policy but cannot link / unlink — that's HQ-controlled per PDPA.
- Reconcile can be run per-branch (`branchCode` filter on `/api/admin/reconcile/run`) so each franchise's queue stays clean.
- A customer who moves between branches retains their `branch_id` — only an admin can re-stamp it. Orders carry their own `branch_id`, so cross-branch service doesn't change customer ownership.

---

## 8. Future enhancements (NOT this phase)

| Step | Why |
|---|---|
| Customer + LINE merge tool | Today there's no UI to merge two `customers` rows that turn out to be the same person. Manual SQL only. |
| Automatic linker for phone-confirmed customers | If the LINE flow ever asks the user to type a phone, the webhook could auto-pair without admin intervention. |
| Cross-branch customer history view | Owners want to see "this customer has been served by 3 branches" — needs a per-customer aggregation query. |
| PDPA self-service unsubscribe inside LINE | Today only LINE's own unfollow does this; a richer self-service flow may live in a future broadcast / CRM phase. |

---

**Last updated:** 2026-05-14 (customer linker + reconcile foundation)
