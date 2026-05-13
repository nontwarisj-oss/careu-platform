# CareU OPS Platform — Google Sheet Sync

> **Status:** permanent reference. The sheet is a customer-facing artefact for finance and operations — every byte we write must respect its layout.

---

## 1. Purpose

The Google Sheet at
`https://docs.google.com/spreadsheets/d/1m1CEANwJLAXhw3Y1wtRoCS99Dplj8AuW_9aOtZ_iza4/edit`
serves three audiences:

| Audience | Use |
|---|---|
| **Accountant** | Monthly P&L export, VAT filing, reconciliation against bank statements. |
| **Branch manager** | Quick filter / pivot across tabs without opening the app. |
| **Owner / fallback** | A read-only mirror of operational state when the platform is briefly unavailable. |

The sheet is **never** the source of truth for orders or pricing once a row exists in the database. It is a mirror for human eyes.

---

## 2. Tabs

| Tab | Direction | Source of truth | Written by |
|---|---|---|---|
| `Front_Desk` | DB → Sheet | `public.orders` | `/api/sync-order-to-sheet` (per-order, fire-and-forget on create + manual retry) |
| `Pricing` | DB → Sheet | `public.service_prices` | `/api/sync-pricing-to-sheet` (snapshot on demand) |
| `Data_Center` | Sheet → DB | the sheet itself | `/api/sync-customers` (manual import) |
| `Expense_Log` | Sheet → DB | the sheet itself | `/api/sync-expenses` (manual import) |
| `Debug` | DB → Sheet | n/a (diagnostic only) | `/api/debug-sheet?dryRun=1` |

---

## 3. `Front_Desk` column contract (A → O)

This is **the** mapping. Front_Desk is the most-read tab so the slightest column drift breaks the accountant's pivots.

| Col | Header | DB source | Notes |
|---|---|---|---|
| A | Date | `orders.created_at` formatted `th-TH` short datetime | "13/5/2569 11:42" |
| B | Job ID | first 8 chars of `orders.id`, upper-cased (when `job_id` is null) OR `orders.job_id` itself once the platform finishes the rollout | Today the sync uses the short refId. Switch to `orders.job_id` in the next pass. |
| C | Customer | `orders.customer_name` | |
| D | Tel | `customers.phone` resolved via `orders.customer_id` | Blank if customer was deleted. |
| E | History | `customer_type` label (Thai) | `ทั่วไป` / `ลูกค้าประจำ` / `VIP`. |
| F | Detail | `service_name — template_text` (or whichever is present) | Single line. Truncation not enforced. |
| G | QTY | `orders.quantity` | Number. |
| H | Price | `orders.price` (net total) | Number, baht. |
| I | Pay Status | `payment_status` Thai label | `ยังไม่ชำระ` / `มัดจำ` / `ชำระแล้ว`. |
| J | Tech | blank | Filled by staff manually for now; future: `orders.tech`. |
| K | Job Status | Thai label | `รอดำเนิน` / `กำลังซ่อม` / `เสร็จสิ้น` / `พร้อมรับ`. |
| L | วันนัด/ด่วน | `ด่วน +฿{fee}` if urgent, else blank | `due_date` not yet wired. |
| M | checkbox | blank | The sheet's data-validation paints the cell as a checkbox; we leave the value blank. |
| N | checkbox | blank | Same. |
| O | Archive | blank | Manager toggles when filing. |

**The row width is exactly 15.** Writing 19 (the previous bug) shifted every value right of column E and overflowed into columns P+ which weren't part of the table — a known incident, fixed in commit `2ed6ff5`.

---

## 4. `Pricing` column contract (A → M)

Each row is a dated snapshot of one currently-effective `service_prices` row. `/api/sync-pricing-to-sheet` appends, never replaces, so the tab accumulates a price history readable next to the in-DB version log.

| Col | Header | DB source |
|---|---|---|
| A | snapshot_at | `now()` formatted `th-TH` |
| B | service_code | `service_prices.service_code` |
| C | category | Thai label from `SERVICE_CATEGORIES` |
| D | service_name | `service_prices.service_name` |
| E | description | `service_prices.description_template` |
| F | price_type | `'fixed'` or `'estimate_required'` |
| G | base_price | number or blank for estimate |
| H | urgent_fee_default | number |
| I | branch_id | uuid or blank for global |
| J | brand_id | text or blank for global |
| K | effective_from | timestamptz |
| L | effective_to | timestamptz or blank |
| M | created_by | `profiles.id` (today: `users.id`) |

---

## 5. Architecture

```
   Browser                        Server (Node runtime)
┌──────────────┐  POST orderId   ┌──────────────────────┐
│ SmartOrderForm├────────────────►│ /api/sync-order-to-  │
│ (fire-forget)│                 │   sheet/route.ts     │
└──────────────┘                 │ • read order + cust  │
   Browser                        │ • build 15-col row   │
┌──────────────┐  POST           │ • call appendRow()   │
│ /pricing     ├────────────────►│                      │
└──────────────┘                 └─────────┬────────────┘
                                            │ uses
                                            ▼
                                  ┌──────────────────────┐
                                  │ lib/googleSheets.ts  │
                                  │ • base64url JWT      │
                                  │ • RSA-SHA256 sign    │
                                  │ • token exchange     │
                                  │ • POST :append       │
                                  └─────────┬────────────┘
                                            ▼
                                  Google Sheets API v4
                                  spreadsheets.values.append
```

### 5.1 Credentials

| Env var | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service-account email, e.g. `careu-sync@...iam.gserviceaccount.com` |
| `GOOGLE_PRIVATE_KEY` | RSA private key. In Vercel: paste as one line with literal `\n`. `lib/googleSheets.ts:18` replaces them with real newlines before signing. |
| `GOOGLE_SHEET_ID` | The spreadsheet id (currently `1m1CEANwJLAXhw3Y1wtRoCS99Dplj8AuW_9aOtZ_iza4`). |
| `GOOGLE_SHEET_ORDER_TAB` | Optional override. Defaults to `Front_Desk`. |
| `GOOGLE_SHEET_PRICING_TAB` | Optional override. Defaults to `Pricing`. |

The service account must be added as **Editor** on the spreadsheet (share dialog → paste the email).

### 5.2 Diagnostics

`/api/debug-sheet` returns a structured presence/shape report **without** leaking secret values (length / first-4 / last-4 / BEGIN-END markers on the key).
`/api/debug-sheet?dryRun=1` performs a live append to the `Debug` tab — recommended after every credential rotation.

---

## 6. Formatting preservation strategy

Status: **implemented** as of the sheet-preservation refactor.

### 6.1 The two write modes

The platform has two write helpers in [`lib/googleSheets.ts`](../lib/googleSheets.ts):

| Helper | Underlying API | Preserves formatting? | When to use |
|---|---|---|---|
| `appendRow(tab, row[])` | `values.append` | ❌ no | Tabs whose formatting comes entirely from column-range rules (ARRAYFORMULA, column-wide conditional formats). |
| `insertFormattedRow(tab, values, opts)` | `batchUpdate` | ✅ yes — dropdowns, checkboxes, borders, font, colors | Any tab where staff configured dropdowns / checkboxes / per-row colors. |

The choice between them is made declaratively in [`lib/sheetConfigs.ts`](../lib/sheetConfigs.ts) — `preserveFormatting: true` routes through `insertFormattedRow`. The domain layer in [`lib/sheetWriters.ts`](../lib/sheetWriters.ts) (`writeOrderRow`, `writePricingRow`, `writeDebugRow`) picks the right path automatically.

### 6.2 What insertFormattedRow does

Three `batchUpdate` requests, in order:

1. **`insertDimension` with `inheritFromBefore: true`**
   Expands the grid; inherits row height + data-validation rules from the row immediately above. This alone covers most dropdown / checkbox situations because data validation in Google Sheets is range-scoped.
2. **`copyPaste` with `pasteType: PASTE_NORMAL`** from a configurable template row
   Propagates per-cell formats (fill / borders / font / number format) + formulas. The template-row index is set per tab in `SHEET_CONFIGS` (typically `1` = first data row beneath the header).
3. **`updateCells` with `fields: 'userEnteredValue'`**
   Writes the actual data, overwriting whatever PASTE_NORMAL put in the columns we have values for. Cells we DON'T pass values for retain the template's content — that's the formula-preservation escape hatch.

```jsonc
{
  "requests": [
    { "insertDimension": { "range": {...}, "inheritFromBefore": true } },
    { "copyPaste":      { "source": {...row=template...}, "destination": {...row=insertAt...},
                          "pasteType": "PASTE_NORMAL" } },
    { "updateCells":    { "rows": [...], "fields": "userEnteredValue",
                          "start": {...row=insertAt...} } }
  ]
}
```

### 6.3 What's preserved end-to-end

| Property | Preserved? | How |
|---|---|---|
| Cell-level fill colour | ✅ | `copyPaste(PASTE_NORMAL)` |
| Border style + colour | ✅ | `copyPaste(PASTE_NORMAL)` |
| Font / size / weight | ✅ | `copyPaste(PASTE_NORMAL)` |
| Number / currency / date format | ✅ | `copyPaste(PASTE_NORMAL)` |
| Per-row dropdown (data validation) | ✅ | `inheritFromBefore: true` + `PASTE_NORMAL` |
| Per-row checkbox | ✅ | `inheritFromBefore: true` (data validation rule inherits) |
| Conditional formatting | ✅ | Rules with row-range expansion auto-cover new rows |
| Formulas in trailing columns | ⚠️ | Survives only if the caller OMITS that column index from the values map. The sparse `Record<number, value>` form of `insertFormattedRow` makes this easy: pass only the columns you want to overwrite. |
| Tab name renamed in Google | ⚠️ | The numeric-sheet-id cache is per warm function. Redeploy to bust it. |

### 6.4 The sparse-write escape hatch

When a tab has a formula in column F, calling `insertFormattedRow` with a 15-element array would overwrite that formula. Use the sparse form instead:

```ts
await insertFormattedRow("Front_Desk", {
  0: dateStr,        // A
  1: jobId,          // B
  2: customerName,   // C
  // skip column F (index 5) — leave the template formula in place
  6: quantity,       // G
  ...
}, { columnCount: 15, templateRowIndex: 1 });
```

Cells with no entry in the map keep whatever PASTE_NORMAL copied in from the template row — including any formula.

### 6.5 The forbidden pattern (historical)

```ts
// ❌ DO NOT do this on a tab with per-row formatting
await appendRow("Some_Tab_With_Dropdowns", [...]);
```

This pattern existed for Front_Desk and Pricing before this refactor and was the source of dropdown / checkbox loss in the past. It is replaced everywhere by `writeOrderRow` / `writePricingRow` (which route through `insertFormattedRow`). `appendRow` remains exported only for tabs explicitly marked `preserveFormatting: false` in `SHEET_CONFIGS` (today: the `Debug` tab).

### 6.6 Rule of thumb

| If you're adding a new tab… | Do |
|---|---|
| Tab has per-row data validation (dropdowns, checkboxes) | Add a `SheetTabConfig` with `preserveFormatting: true` + a `templateRowIndex` pointing at the first data row. Add a `writeXxxRow` helper in `lib/sheetWriters.ts`. |
| Tab is diagnostic / append-only with no formatting | `preserveFormatting: false` and the same writer pattern. |
| Existing tab loses a dropdown after a deploy | Open the sheet, set the dropdown via data validation on the **whole column** (Data → Data validation → Apply to range = "A2:A"), and the issue disappears for every future row. |

---

## 7. Sync UX

### 7.1 Order create
- `SmartOrderForm` fires the sync **fire-and-forget** after a successful insert. The form does not block on it.
- The document page (`/orders/[id]/document`) shows a sync-status pill — `รอซิงค์ / กำลังซิงค์ / ซิงค์แล้ว / ล้มเหลว` — plus a retry button.
- Audit row written on success: `order_audit_log(action='sync_pushed', after_value='front_desk_tab')`.

### 7.2 Pricing snapshot
- `/pricing` → "Sync to Google Sheet" button → POST `/api/sync-pricing-to-sheet`.
- Response surfaces `appended` count + target tab in a Thai toast.

### 7.3 Customer import
- `/customers` → "ซิงค์จาก Google Sheet" → reads `Data_Center` via gviz CSV, dedups by `normalized_phone`, returns `{ inserted, matchedExisting, skipped, totalRows }`.

### 7.4 Expense import
- `/expenses` → "ซิงค์ Expense_Log" → reads the Expense_Log tab, validates header row, upserts into `public.expense_log`.

---

## 8. Failure modes & how the platform handles them

| Failure | Detection | UX |
|---|---|---|
| Credentials missing | `readGoogleSheetsConfig()` returns null | 503 from sync route with `missing: [...]` list; pill turns red with tooltip. |
| Private key malformed | `crypto.createSign` throws "DECODER routines" | 502 with hint "ตรวจรูปแบบ private key — newline หาย?". |
| Service account not Editor | Google returns 403 | 502 with `PERMISSION_DENIED` — hint surfaces in the failure pill tooltip. |
| Wrong sheet id | Google returns 404 | 502; hint mentions the sheet id and tab name. |
| Wrong tab name | Google returns 400 | 502; hint mentions the tab name. |
| Transient network error | fetch throws | 502 with the raw error; retry button still functional. |
| Sync partially completes (pricing batch) | route stops on first failure | response includes `appended` + `remaining`; staff retries later. |

Every failure is logged to the Vercel function log via `console.error("[sync-…] …")` for postmortem.

---

## 9. Future architecture

| Step | Why |
|---|---|
| ~~Switch Front_Desk to `batchUpdate` with `inheritFromBefore`~~ | ✅ Done — all `preserveFormatting: true` tabs use `insertFormattedRow`. |
| `public.sync_failures` table + cron retry | `logSyncFailure` in [`lib/syncFailures.ts`](../lib/syncFailures.ts) is a stub today — it emits a structured `[sync-failure]` log line. Promote to a DB queue that a scheduled job retries. |
| Add a "reconcile" job that diffs the DB against the sheet | Catch missed syncs (e.g. orders created during a credential outage). |
| Per-branch tabs (e.g. `Front_Desk_SLM`, `Front_Desk_C24`) | Cleaner per-branch filtering for accountants. Implementation: tab name read from `branches.short_code`. |
| Webhook trigger from sheet edits | Accountant edits a payment status in the sheet → server picks it up via Google Apps Script → updates DB. Today this would clobber the DB without warning, so it's gated behind a manual reconcile UI. |
| Move sheet-id + tab names into `system_settings` | No redeploy needed to point at a different sheet. |

---

## 10. The two rules

1. **The DB is the source of truth.** If the DB and the sheet disagree about an order, the DB wins. Reconciliation tools must reflect this.
2. **Never write a row width different from the column contract.** If the contract has 15 columns, the array has 15 cells. Period.

---

**Last updated:** 2026-05-13 (sheet preservation refactor — `lib/sheetWriters.ts` + `lib/sheetConfigs.ts` + `insertFormattedRow`)
