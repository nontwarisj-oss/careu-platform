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

Today's writes use `spreadsheets.values.append` with `valueInputOption=USER_ENTERED, insertDataOption=INSERT_ROWS`. This:
- ✅ inserts a brand-new row at the end of the data range.
- ✅ parses numbers / dates / booleans via the same rules as keyboard input.
- ⚠️ **does NOT propagate the formatting / data-validation / formula / checkbox configuration** from the row above.

### 6.1 What works today

| Property | Status |
|---|---|
| Plain values | ✅ correct |
| Numbers parsed as numbers | ✅ correct (via USER_ENTERED) |
| Dates parsed when the column is `th-TH` text | ✅ correct |
| Auto-row-height | ✅ default behaviour |
| Cell colours that come from **conditional formatting rules** | ✅ preserved (rules apply to all rows in their range) |
| Checkbox in M / N / O | ⚠️ only when the column has range-level data validation rule (set once in the sheet template) |

### 6.2 What breaks today

| Property | Status |
|---|---|
| Manual cell-level fill / border / font | ❌ not copied |
| Per-row conditional formats applied via copy-paste | ❌ not copied |
| Formulas in trailing columns (P+) | ⚠️ broken when the column has a hand-typed formula instead of an `ARRAYFORMULA` |
| Dropdown when the validation is set per-row, not per-column | ❌ not copied |

### 6.3 The forbidden pattern

```ts
// ❌ DO NOT do this — destroys per-row formatting in many sheets
await appendRow(SHEET_TAB, [...]); // unconditional, no template copy
```

`appendRow` is fine **only when** the target tab's formatting comes from column-range rules (conditional formatting, column-wide data validation, ARRAYFORMULA in the header row). Front_Desk and Pricing meet this bar today because of how the sheet was set up.

### 6.4 The next-phase pattern (template-preserving append)

When a tab acquires per-row formatting we cannot move to column-range rules, switch to `spreadsheets.batchUpdate` with `copyPaste`:

```jsonc
{
  "requests": [
    {
      "insertDimension": {
        "range": { "sheetId": <numeric>, "dimension": "ROWS",
                   "startIndex": <last+1>, "endIndex": <last+2> },
        "inheritFromBefore": true
      }
    },
    {
      "copyPaste": {
        "source":      { "sheetId": <numeric>, "startRowIndex": <template>, "endRowIndex": <template+1>,
                         "startColumnIndex": 0, "endColumnIndex": 15 },
        "destination": { "sheetId": <numeric>, "startRowIndex": <last+1>, "endRowIndex": <last+2>,
                         "startColumnIndex": 0, "endColumnIndex": 15 },
        "pasteType": "PASTE_NORMAL",
        "pasteOrientation": "NORMAL"
      }
    },
    {
      "updateCells": { /* set the actual values for the new row */ }
    }
  ]
}
```

`inheritFromBefore: true` copies the row-height + per-cell properties from the row above; `PASTE_NORMAL` carries formatting + data validation + formulas. The third request fills in the data.

`lib/googleSheets.ts` is structured so adding a `batchUpdate` helper next to `appendRow` is straightforward — it shares the JWT exchange path.

### 6.5 Rule of thumb

| If the tab has… | Use |
|---|---|
| ARRAYFORMULA-driven columns and column-wide conditional formats | `appendRow` (today's path) |
| Hand-typed per-row formulas, manual colour fills, per-row dropdowns | `batchUpdate` with `copyPaste` (next-phase path) |

When in doubt: open the sheet → format a test row → run a dry-run via `/api/debug-sheet?dryRun=1` against a copy of the tab and inspect by eye. Don't ship if formatting drifts.

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
| Switch Front_Desk to `batchUpdate` with `inheritFromBefore` | Resilient against future tab redesign with per-row formatting. |
| Add a "reconcile" job that diffs the DB against the sheet | Catch missed syncs (e.g. orders created during a credential outage). |
| Per-branch tabs (e.g. `Front_Desk_SLM`, `Front_Desk_C24`) | Cleaner per-branch filtering for accountants. Implementation: tab name read from `branches.short_code`. |
| Webhook trigger from sheet edits | Accountant edits a payment status in the sheet → server picks it up via Google Apps Script → updates DB. Today this would clobber the DB without warning, so it's gated behind a manual reconcile UI. |
| Move sheet-id + tab names into `system_settings` | No redeploy needed to point at a different sheet. |

---

## 10. The two rules

1. **The DB is the source of truth.** If the DB and the sheet disagree about an order, the DB wins. Reconciliation tools must reflect this.
2. **Never write a row width different from the column contract.** If the contract has 15 columns, the array has 15 cells. Period.

---

**Last updated:** 2026-05-13 (commit 4805d3b)
