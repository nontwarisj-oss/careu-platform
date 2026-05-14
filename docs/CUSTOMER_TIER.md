# CareU OPS Platform — Customer Tier

> **Status:** permanent reference. The tier model is the platform's first take on customer value segmentation. It informs the badge on `/customers` and is the input layer the future CRM automation will consume.

---

## 1. Tier vocabulary

Four tiers, ordered roughly by lifetime value:

| Tier | Trigger |
|---|---|
| **PREMIUM** | lifetime spend ≥ `PREMIUM_LIFETIME_SPEND` (฿20,000) AND last visit within `PREMIUM_WINDOW_DAYS` (90 days). |
| **VIP** | lifetime spend ≥ `VIP_LIFETIME_SPEND` (฿5,000) OR total orders ≥ `VIP_ORDER_COUNT` (5). |
| **REGULAR** | At least one order, doesn't meet VIP / PREMIUM criteria, and active within the last `INACTIVE_AFTER_DAYS` (365 days). |
| **INACTIVE** | Zero orders, OR no orders in the last `INACTIVE_AFTER_DAYS` days. INACTIVE wins over every other tier — we'd rather mark a former VIP inactive than keep promoting them as VIP after a year of silence. |

All thresholds live in [`lib/customerTierService.ts::TIER_THRESHOLDS`](../lib/customerTierService.ts) so HQ can re-tune by editing one constant. Migration not required.

---

## 2. Why these rules

- **Lifetime spend > order count.** A customer with two ฿15,000 jobs is more valuable than one with ten ฿200 jobs. We still give VIP a fallback by order count for the loyalty case (frequent small visits).
- **PREMIUM requires recency.** A one-time big spender from two years ago isn't currently a PREMIUM customer; the recency gate prevents stale promotion.
- **INACTIVE is a hard top-level state.** It overrides PREMIUM and VIP so a stale record looks honest. Re-activation happens naturally on next order — recompute lifts them back.
- **No branch-specific tier yet.** The customer carries one tier across the chain. Branch affinity (`primary_branch_id`) is stored separately so a future per-branch loyalty programme can read it.

---

## 3. Schema (post-`20260531`)

`public.customers` carries the read surface for the tier badge:

| Column | Source | Maintained by |
|---|---|---|
| `customer_tier` | `calculateCustomerTier(stats)` | `refreshCustomerTier` |
| `total_orders` | `count(orders WHERE customer_id = …)` | `refreshCustomerTier` |
| `lifetime_spend` | `sum(orders.price)` | `refreshCustomerTier` |
| `last_visit_at` | `max(orders.created_at)` | `refreshCustomerTier` |
| `latest_service` | most recent `orders.service_name` (falls back to `item_name`) | `refreshCustomerTier` |
| `primary_branch_id` | branch slug with the highest `count(orders)` for the customer | `refreshCustomerTier` |

`total_orders / latest_service / customer_tier` predate this phase (migration `20260521` scaffolded them) but were never written. The new service is the writer.

---

## 4. Refresh model

**Manual (this phase):**
- Owner / HQ / branch_manager clicks **"Refresh tiers"** on `/customers`. The route `POST /api/admin/customer-tier/refresh` batches up to 500 customers per call.
- Branch_manager calls are forced to their `branchCode` server-side — they can't trigger an all-branch refresh.

**Single customer (also this phase):**
- POST with `{ customerId }` to refresh exactly one row. Used by future "view customer" admin actions.

**Future cron (next phase):**
- The same library function is callable from a cron job (`refreshBranchCustomerTiers(branchCode)`). Wiring is identical to the existing `/api/cron/retry-worker` pattern — a Bearer `CRON_SECRET` route that calls into the service.

**Future DB trigger:**
- A `BEFORE UPDATE ON orders` trigger could recompute on every order touch. Deliberately not built this phase — coupling the order write path to a customer aggregate recompute adds latency to the storefront flow we're not willing to absorb yet.

---

## 5. How the tier reaches the UI

```
public.customers.customer_tier ──┐
                                  │  read in fetchCustomers (CustomerRow ext.)
public.customers.lifetime_spend ──┼─▶  tierByCustomer state map
public.customers.last_visit_at ──┘                       │
                                                          ▼
                              EnrichedCustomer.tier  (rendered as a
                                                      small badge next
                                                      to customer name)
```

The badge is purely cosmetic — the underlying logic doesn't gate anything yet. A future "VIP-only promotion" pricing rule would read `customer_tier` from the order's joined `customers` row.

---

## 6. Branch isolation

- **Read.** `public.customers` is already RLS-scoped (branch_manager sees their branch + global; admins see all). The tier columns ride along — no separate gate.
- **Write.** `/api/admin/customer-tier/refresh` goes through `requireRole` + (for managers) forces `branchCode = profile.branchCode`. The library function `refreshBranchCustomerTiers` accepts the resulting scope.
- **Cross-branch primary_branch_id.** A customer who orders at multiple branches still has one `primary_branch_id` (the branch with the highest order count). Branch managers see the customer if they originated there OR the branch ever appears in the customer's orders (current customers RLS).

---

## 7. Tuning thresholds

Edit [`lib/customerTierService.ts::TIER_THRESHOLDS`](../lib/customerTierService.ts) and redeploy. The next refresh batch picks up the new rules — existing rows stay at the old tier until refresh runs. Deliberately a hot path: HQ can A/B the thresholds without a migration.

If a tier definition changes in a way that needs migration (e.g. adding a TIER value), update the doc, add a checked-in default to the helper, ensure the `customer_tier` column accepts the new value (`text` today, no CHECK), and queue a one-shot full refresh.

---

## 8. Future enhancements (not this phase)

| Step | Why |
|---|---|
| DB trigger or scheduled cron | Today refresh is admin-clicked. A 5-minute cron sweeping the most-recently-active customers is the obvious next step. |
| Per-branch tiers | A customer might be VIP at one branch and REGULAR at another. Needs a separate join table. |
| Tier-aware promotions | Once the badge is trusted, plug it into the pricing engine (e.g. PREMIUM gets free urgent fee). |
| Customer merge | Two `customers` rows that are the same person currently confuse the tier (each row computes independently). Future merge tool resolves this — see CUSTOMER_IDENTITY.md §8. |
| Tier history | A small `customer_tier_history` table tracking transitions over time, useful for retention analytics. |

---

**Last updated:** 2026-05-14 (tier writer + insight columns + customers badge)
