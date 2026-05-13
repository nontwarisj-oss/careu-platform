# CareU OPS Platform — Pricing Rules

> **Status:** permanent reference. The numbers below are the source of truth — code must match. If you find drift, the doc is right and the code is wrong (fix the code).

---

## 1. Pricing engine philosophy

1. **Predictable.** The same inputs always produce the same total — no UI surprises.
2. **Editable without redeploy.** Live prices live in `public.service_prices` and are edited at `/pricing`. The hardcoded `SERVICES` array in `lib/pricing.ts` is a **safety-net fallback** for codes the DB doesn't yet carry.
3. **Versioned + audited.** Every price change preserves history via `effective_from / effective_to / is_active`. "Save as new version" closes the old row, inserts a new one. A Postgres trigger writes every INSERT / UPDATE / DELETE to `public.pricing_audit_logs` automatically — no app code can forget.
4. **Branch / brand-aware.** A service can have a global default + branch-specific or brand-specific overrides. Most-specific wins.
5. **Transparent to the customer.** Urgent fees and discounts appear as separate line items on the receipt. No hidden bundling.

## 1b. Layered architecture (post-`20260523`)

| Layer | Module | What it owns |
|---|---|---|
| **A — pricing data** | [`lib/pricingDb.ts`](../lib/pricingDb.ts) | Reads `service_prices` with progressive fallback to hardcoded `SERVICES`. CRUD helpers for the `/pricing` page. |
| **B — pricing rules** | [`lib/pricingService.ts`](../lib/pricingService.ts) | `getServicePrice`, `calculateUrgentFee`. Resolves the per-line surcharge from the catalog row or the global default. |
| **C — promotion rules** | [`lib/pricing.ts`](../lib/pricing.ts) `PROMOTIONS` + `computeDiscount`, called via [`lib/pricingService.ts::calculatePromotionDiscount`](../lib/pricingService.ts) | Tier walk for B2S, exclusion-code check, manual override. |
| **D — receipt display** | [`lib/pricingService.ts::calculateFinalPrice`](../lib/pricingService.ts) → `ReceiptLine[]` | Subtotal, "คิวงานด่วน", discount, total — each as a discrete line for the receipt. |

UI files (forms, receipt) should NEVER compute discount or urgent surcharges inline. They call `calculateFinalPrice`.

---

## 2. Core formula

For one order, the total is:

```
subtotal       = unit_price × quantity
urgent_charge  = urgent ? urgent_fee : 0
gross          = subtotal + urgent_charge
discount       = computeDiscount(subtotal, promotionCode, manualDiscount)
total          = max(0, gross - discount)
```

Implemented in [`lib/pricing.ts`](../lib/pricing.ts) (`computeDiscount`) and consumed by [`components/SmartOrderForm.tsx`](../components/SmartOrderForm.tsx).

The `subtotal` parameter to `computeDiscount` is the pre-urgent subtotal — urgent charges never qualify for discounts.

---

## 3. Urgent fee ("คิวงานด่วน")

**Default rule:** `+30 THB per item`.

The receipt line item label:
- Thai: `คิวงานด่วน`
- English: `Urgent fee`

Behaviour in the form:
1. Staff toggles the **งานด่วน** checkbox.
2. Quick presets exposed: `+30` and `+50` (constants in `URGENT_MODIFIERS`, `lib/pricing.ts`).
3. Freeform input — staff can type any non-negative number.
4. When a service is selected, if `service_prices.urgent_fee_default` is set, the form pre-fills `urgentFee` from that value.

**Future expansion (not yet implemented):**
- Multiple urgent tiers per service (e.g. same-day vs next-day).
- Tier auto-selected based on the chosen `due_date`.

---

## 4. Back to School promotion (`B2S`)

**Canonical rule (tiered, per order):**

| Subtotal (THB) | Discount (THB) |
|---|---|
| 200 – 299 | 20 |
| 300 – 499 | 30 |
| 500 – 999 | 50 |
| ≥ 1000 | 100 |

- The threshold check is on **subtotal** (pre-urgent, pre-discount).
- Discount applied as a flat baht amount, not a percentage.
- One discount per order. Stack with urgent fee, never with another promotion.

**Excluded items:**
- Student name embroidery — encoded as `Promotion.excludedServiceCodes` on the B2S row in [`lib/pricing.ts`](../lib/pricing.ts). `lib/pricingService.ts::calculatePromotionDiscount` checks the order's `serviceCode` against this list and returns 0 when excluded.

**Status of code vs spec:** ✅ **Aligned.** As of `20260523_pricing_engine.sql` the B2S row is `type: 'tiered'` with the four tiers above, `computeDiscount` walks them and picks the highest match, and `calculatePromotionDiscount` enforces the exclusion list. The historical 10 %-flat behaviour is gone.

Moving promotions out of `lib/pricing.ts` into a versioned `promotions` DB table is the next refactor step (deferred — this commit landed schema + engine first).

---

## 5. Special rules (per-service overrides)

These are services whose price is fixed by rule, not by the catalog default:

| service_code | Display | Price | Pricing rule |
|---|---|---|---|
| `REP-002-PZ6` | ซิปพลาสติก 6 นิ้ว (กางเกง) | **130 THB flat** | Replaces the standard zipper price for this exact spec. |
| `ALT-001-RCN` | เย็บชายกางเกงยีนส์แบบ Reconstruction | **200 THB flat** | Re-cut at the original hem with the original stitching shape. No extra taper fee. |
| Standard reconstruction hem | (covered by `ALT-001-RCN`) | base only | No extra taper fee even if the leg is tapered. |

**Status of code vs spec:** ✅ **Seeded by `20260523_pricing_engine.sql`** into `public.service_prices` (global, `business_type='care_u'`, `is_active=true`). The `/pricing` page surfaces them like any other row; the order form picks them up via `fetchPricingCatalog`.

---

## 6. Discount calculation (`computeDiscount`)

```ts
function computeDiscount(subtotal, promotionCode, manualDiscount): number
```

| Inputs | Result |
|---|---|
| `promotionCode = 'MANUAL'` or any `manualDiscount > 0` | `floor(manualDiscount)`, clamped to subtotal |
| `promotionCode = 'NONE'` | `0` |
| `promotionCode = 'B2S'`, current implementation | `floor(subtotal × 10 / 100)`, clamped to subtotal **(drift — see §4)** |
| `promotion.type = 'percent'` | `floor(subtotal × percent / 100)` |
| `promotion.type = 'flat'` | `min(flatValue, subtotal)` |
| Unknown promotion | `0` |

Negative or NaN inputs are coerced to 0 by `Math.max` / `Math.floor` chains.

---

## 7. Customer-tier perks (forward-looking)

Customer tier is computed by `lib/customerStats.ts`:
- `0 – 1 orders` → `new` (ลูกค้าใหม่)
- `2 – 4 orders` → `repeat` (ลูกค้าประจำ)
- `5+ orders` → `vip` (VIP)

Today the tier is **display-only**. The plan:
- VIP customers get an automatic 5 % loyalty discount (next phase).
- Repeat customers receive priority queueing on urgent orders (operational rule, no price change).

Document any future tier-based pricing in this section before implementing.

---

## 8. Historical pricing support

`public.service_prices` keeps every version forever:

| Column | Purpose |
|---|---|
| `effective_from` | Version starts (defaults to insert time). |
| `effective_to` | Version ends (NULL = currently effective). |
| `active` | Whether this version applies. `false` AND `effective_to NOT NULL` = retired. |
| `created_by` | who edited (future: `profiles.id`). |

Lookups for "what was the price for service X on date Y":
```sql
select base_price, price_type
from public.service_prices
where service_code = $1
  and (effective_from is null or effective_from <= $2)
  and (effective_to is null or effective_to > $2)
  and active
order by effective_from desc
limit 1;
```

Front-end reports (`/reports/revenue`, `/reports/profit`) currently use today's price for every historical order — this is **good enough for V1** because price drift is small. A future revenue report can use the snapshot lookup above to compute per-order historical price.

---

## 9. Pricing UX rules

### On the order form
- Selecting a service auto-fills `unit_price` from the catalog. Staff CAN override.
- Selecting an `estimate_required` service (where `base_price = null`) shows the placeholder `ต้องประเมินราคา` and requires staff to type a number before saving.
- Quantity defaults to 1 and is editable.
- Urgent fee defaults to the catalog default (or 30 THB if absent).
- The summary block shows: `subtotal`, `urgent_fee`, `discount`, `total` — each as a separate line.

### On the receipt
- Show the breakdown identically to the form.
- Never collapse multiple lines into one. The customer must see "Urgent fee +30" as a distinct row.

### On `/pricing`
- Filters: search by code/name, category dropdown, "include inactive".
- Per-row actions: **Edit** (modal) and **Disable** / **Enable**.
- "Save as new version" closes the old row and inserts a new one. "Quick edit" mutates in place — use it for typos only.
- "Sync to Google Sheet" appends one row per active service to the `Pricing` tab with the current snapshot timestamp.

---

## 10. Future expansion strategy

| Capability | Plan |
|---|---|
| Time-of-day pricing | Add `service_prices.weekend_multiplier` + `service_prices.evening_multiplier` columns. |
| Customer-tier auto discount | Compute on the fly in `computeDiscount` using a `customerTier` parameter. |
| Bundle pricing (multiple services discounted together) | Introduce `bundles` table with eligibility rules. |
| Per-fabric / per-material surcharge | `service_prices.material_modifiers` JSONB column. |
| FX-aware pricing (if expanding outside Thailand) | Add `currency` and `exchange_rate_source` columns; receipts continue to show baht. |

Every future expansion ships with:
1. A migration adding the columns.
2. An update to `computeDiscount` (or its successor).
3. An entry in this doc with the spec, examples, and code references.

---

## 11. Quick reference — current catalog (hardcoded fallback)

`SERVICES` in [`lib/pricing.ts`](../lib/pricing.ts) — used when `service_prices` is empty or unreachable:

| Code | Category | Name (TH) | Base (THB) |
|---|---|---|---|
| ALT-001 | alteration | ตัดขากางเกง | 80 |
| ALT-002 | alteration | ตัดเอวกางเกง | 120 |
| ALT-003 | alteration | ตัดแขนเสื้อ | 100 |
| ALT-004 | alteration | ปรับขนาดเสื้อ/กางเกง | 150 |
| REP-001 | repair | ปะรูเสื้อ/กางเกง | 60 |
| REP-002 | repair | เปลี่ยนซิป | 150 |
| REP-003 | repair | ติดกระดุม (ต่อเม็ด) | 20 |
| REP-004 | repair | เย็บตะเข็บที่ขาด | 40 |
| LTH-001 | leather | ซ่อมหนังถลอก/ขาด | estimate |
| LTH-002 | leather | ทาสีหนัง | estimate |
| LUG-001 | luggage | ซ่อม/เปลี่ยนล้อกระเป๋าเดินทาง | 250 |
| LUG-002 | luggage | ซ่อมหูจับกระเป๋า | estimate |
| DRY-001 | drycleaning | ซักแห้งเสื้อเชิ้ต | 80 |
| DRY-002 | drycleaning | ซักแห้งสูท | 200 |
| SPC-001 | special | งานปักพิเศษ | estimate |
| SPC-999 | special | งานอื่นๆ (ระบุเอง) | estimate |

The hardcoded fallback exists so a brand-new database can run the form without manual data entry. The moment HQ adds the first row to `service_prices`, the DB takes over.

---

**Last updated:** 2026-05-13 (migration 20260523_pricing_engine.sql)
