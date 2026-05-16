# Production Rollout — Care U C24 Branch Pilot

Rollout guide for putting the OPS platform into real storefront use at
the **Care U C24** branch. Scope: back-office + storefront operations
only (the customer-facing website is developed separately and is out of
scope here).

Companion docs: [OPERATIONAL_REGRESSION.md](./OPERATIONAL_REGRESSION.md)
(the manual test pass), [ARCHITECTURE.md](./ARCHITECTURE.md),
[GOOGLE_SHEET_SYNC.md](./GOOGLE_SHEET_SYNC.md).

---

## 1. Rollout checklist

Tick every box before letting branch staff work on the platform.

### Environment
- [ ] `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` set.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` set (server-only — recalc, merge,
      signed uploads, crons all need it).
- [ ] `CRON_SECRET` set (12 crons authenticate with it).
- [ ] `NEXT_PUBLIC_SITE_URL` / `NEXT_PUBLIC_BASE_URL` /
      `NEXT_PUBLIC_LINE_OA_URL` set.

### Database
- [ ] Migration `20260554_order_items.sql` applied.
- [ ] Migration `20260555_order_item_status.sql` applied.
- [ ] At least one active row in `public.branches` for C24.
- [ ] At least one `owner` / `hq_admin` profile exists.

### Storage
- [ ] Supabase Storage bucket **`customer-uploads`** exists and is
      **private**. (Already required by the public quote uploader; the
      OPS per-item photo workflow reuses it.)
- [ ] A test image uploads from `/intake` and is viewable in the order
      document gallery.

### Verification
- [ ] `/admin/system/smoke-test` → overall **healthy** (or only
      expected warnings). The **Store operations** category is green.
- [ ] Full pass of [OPERATIONAL_REGRESSION.md](./OPERATIONAL_REGRESSION.md)
      on the actual front-counter tablet.
- [ ] Build is clean: `npm run build` (cron-manifest gate passes).

### Data hygiene (one-time, post-deploy)
- [ ] `/customers` → **Refresh tiers** (recompute visits/spend).
- [ ] `/customers` → **จับคู่ใบงาน** — resolve any unlinked orders.
- [ ] `/customers` → **รวมลูกค้าซ้ำ** — merge obvious duplicates.

---

## 2. Deployment sequence

Run **in order**. Migrations are additive — apply them *before* the new
code so the code never queries a column that does not exist yet.

1. **Freeze** — announce a short maintenance window (off-hours).
2. **Back up** the database (Supabase dashboard → snapshot).
3. **Apply migrations**, oldest first:
   1. `supabase/migrations/20260554_order_items.sql`
   2. `supabase/migrations/20260555_order_item_status.sql`
   Both are idempotent (`if not exists`) — safe to re-run.
4. **Confirm storage** — `customer-uploads` bucket present + private.
5. **Deploy the code** (Vercel — the build's `prebuild` cron-manifest
   gate must pass).
6. **Smoke test** — open `/admin/system/smoke-test`; expect healthy.
7. **Regression pass** — work [OPERATIONAL_REGRESSION.md](./OPERATIONAL_REGRESSION.md)
   on the tablet.
8. **Data hygiene** — the one-time steps in §1.
9. **Unfreeze** — hand the tablet to branch staff.

---

## 3. Rollback procedure

The platform is **rollback-safe by design** — every change this cycle
was additive.

### Preferred: code-only rollback
- Redeploy the previous Vercel build.
- **Leave the migrations applied.** `order_items` and
  `order_items.status` are additive — older code simply ignores them.
  Orders created as multi-item still render: the receipt layer falls
  back to the order header's own item columns when it does not read
  `order_items`.
- No data loss. This is the recommended rollback for any code-level
  issue.

### Only if a migration itself is implicated
Run the `ROLLBACK` block documented at the top of each file:
- `20260555` → `alter table public.order_items drop column if exists status;`
- `20260554` → `drop table if exists public.order_items;`
Dropping `order_items` discards multi-item detail (the order **headers**
and their totals survive — no order is lost). Take a fresh DB snapshot
first. This should rarely be necessary.

### Storage
Uploaded photos live in `customer-uploads`; a code rollback does not
touch them. They remain referenced by `order_items.image_paths`.

---

## 4. Known limitations

Honest list — none blocks the C24 single-branch pilot.

- **Branch isolation is app-layer, not RLS.** `orders` runs with RLS
  disabled (per the original product decision); the active branch is
  held in the browser (`careu.branchId`) and the operations board
  scopes to it. A determined operator could change the stored branch.
  This is the existing framework model — unchanged this cycle. Real
  DB-level row isolation is a future, non-additive project.
- **List caps at ~1000 rows.** The customer picker and the board's
  per-order item-count read one page (~1000 rows). Fine for a single
  branch building up volume; revisit (pagination) before multi-branch
  scale. The visit/spend **recalc** already paginates fully.
- **Per-item photos are grouped by item, not tagged before/after.**
  `image_paths` is a flat list per item; the gallery groups by garment.
  Per-photo before/after labels would need a metadata change.
- **Customer merge moves orders + activity + notifications + notes.**
  Derived singleton rows (lifecycle status, engagement rollups) on the
  duplicate are cascade-removed with it — they recompute on the next
  aggregation. Invoices/payments/receipts are the order itself.
- **Rate limiting is per-process** (in-memory) — resets on cold start.
  Adequate for casual abuse at one branch.
- **Customer-facing website is frozen** — developed separately; this
  platform only keeps the public APIs.

---

## 5. Pilot testing guide — for branch staff

Practical guide for C24 counter staff for the first week.

### Before customers arrive (day 1, ~15 min)
1. Open the platform on the counter **tablet**; sign in.
2. Confirm the branch shown is **C24**.
3. Do a dry run: create a test intake with 2 items (one urgent),
   save, open it on `/orders`, advance its status, then cancel it.
4. Take one photo on a test item to confirm the camera upload works.

### Taking in a repair (`/intake`)
- Pick the customer (search by phone) or **+ เพิ่มลูกค้าใหม่**.
- One ticket can hold **several garments** — use **+ เพิ่มรายการ** for
  each piece.
- Per garment: category → service (or **อื่นๆ** to type a custom one),
  detail, price, quantity. Toggle **คิวงานด่วน** for rush work.
- Set a **กำหนดรับงาน** (due date) and snap **photos** of the garment /
  any damage.
- Care U: type the **Job ID** yourself. Ezy Repair: the system makes
  one automatically.
- **บันทึกใบงาน** → the receipt opens; print or hand to the customer.

### Running the floor (`/orders`)
- The board is the day's work. Use the **queue chips**: กำหนดวันนี้,
  เลยกำหนด, งานด่วน, **ตรวจงาน (QC)**, พร้อมรับ, ค้างชำระ.
- Move a job forward with the one-tap **→ next status** button. Use the
  dropdown for anything off the happy path (rออะไหล่, ส่งงานนอก, cancel).
- Tap a card to see every garment, set **per-item status**, and add
  **after-repair photos**.

### When the customer collects
- Find the job (search or the **พร้อมรับ** queue).
- Advance to **delivered**; update payment if needed; reprint the
  receipt from the document page.

### Customer housekeeping (`/customers`)
- A long-time customer shows as **new**? → **Refresh tiers**.
- An order not counting toward a customer? → **จับคู่ใบงาน**.
- Same person twice? → **รวมลูกค้าซ้ำ** (owner/HQ).

### Report a problem
Note the **Job ID**, what you tapped, and what happened — pass it to
HQ. Do not retry destructive actions repeatedly.

### Week-1 success signals
- Every walk-in becomes a ticket; nothing tracked on paper.
- The board reflects reality — no stale statuses.
- Receipts print correctly every time.
- `/admin/system/smoke-test` stays healthy.

---

**Last updated:** 2026-05-16 (C24 pilot rollout hardening)
