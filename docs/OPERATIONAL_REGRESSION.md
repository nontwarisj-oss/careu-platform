# Operational Regression Checklist — Care U OPS

Pre-rollout / post-deploy manual pass for the real storefront workflow.
Run on a **tablet** (front-counter device) for each branch. Automated
read-only validation lives in `/admin/system/smoke-test` → the **Store
operations** category — run that first; this checklist covers what a
script cannot.

Migrations required: `20260554` (order_items), `20260555`
(order_items.status). Storage bucket `customer-uploads` configured.

---

## 1. Intake — multi-item repair ticket (`/intake`)

- [ ] Add 3+ items to one ticket via **+ เพิ่มรายการ**.
- [ ] Per item: pick a category, then a service from the dropdown
      (full `service_prices` catalog is reachable without a category).
- [ ] **Other / อื่นๆ** — type a custom service name + detail + price;
      it saves on the item.
- [ ] Toggle **คิวงานด่วน** on one item → its urgent fee shows
      separately in the summary; grand total updates.
- [ ] Set a per-item due date + assign a technician.
- [ ] Attach 2+ photos to an item (camera/gallery on the tablet) →
      thumbnails appear, tap to preview.
- [ ] Save → routed to the document; receipt shows **one line per
      item**; grand total matches.
- [ ] DB: `order_items` has one row per garment; `orders.price` =
      grand total.

## 2. Orders operations board (`/orders`)

- [ ] Queue chips (today / overdue / urgent / QC / ready / waiting
      payment) show correct counts.
- [ ] One-tap **→ next status** advances the happy path; the dropdown
      still does non-linear moves (waiting_parts, outsource, cancel).
- [ ] Technician filter + customer/Job-ID/phone search work.
- [ ] **Branch isolation:** log in as a branch-locked role → board
      shows only that branch; owner/HQ → branch dropdown switches.
- [ ] Open a card → detail modal lists each item with its own status
      changer + photos.

## 3. Customer data integrity (`/customers`)

- [ ] A phone imported without its leading zero displays as
      `0XX-XXX-XXXX`; search finds it by both `08...` and `8...`.
- [ ] **Refresh tiers** → visit count + spend recompute; cancelled
      orders are excluded from spend.
- [ ] **จับคู่ใบงาน** (unmatched resolver) → an orphan order links to a
      customer; that customer's visits/spend update.
- [ ] **รวมลูกค้าซ้ำ** (owner/HQ) → preview shows orders to move →
      confirm → duplicate gone, survivor keeps combined history; a
      merge note is on the survivor; `customer_activity` /
      `customer_notifications` / `customer_notes` moved too.

## 4. Receipt / document (`/orders/[id]/document`)

- [ ] A4 / thermal / mobile receipt renders; multi-item lines correct.
- [ ] Photo gallery (internal, `print:hidden`) groups photos by item.
- [ ] Payment status + cost panel save.

## 5. Sync / retry

- [ ] Manual **ซิงค์จาก Google Sheet** imports new customers, dedups
      by phone, never overwrites existing stats.
- [ ] `sync-customers` cron heartbeat is green in
      `/admin/system/workers`.

## 6. Regression — must still work

- [ ] Auth + RBAC: each role lands on its allowed pages only.
- [ ] LINE: a status change to in-progress / ready / completed enqueues
      a customer notification.
- [ ] Pricing: urgent fee + discount math on the receipt is correct.
- [ ] No console errors on intake / orders / customers / document.
- [ ] `/admin/system/smoke-test` overall = healthy (or only expected
      warnings).

---

**Last updated:** 2026-05-16 (Store Ops Hardening — final QA tooling)
