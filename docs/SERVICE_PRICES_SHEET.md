# Pricing Master — Google Sheet "Service_Prices" tab

The Google Sheet is the **easy editing surface** for service pricing.
`public.service_price_master` is the **system source of truth**. An
owner-only server route syncs the sheet INTO the table — never the
other way around.

- Workbook: the same spreadsheet as the rest of the platform (`GOOGLE_SHEET_ID`).
- Tab name: **`Service_Prices`** (exact, case-sensitive).
- Sync route: `POST /api/admin/pricing-master/sync` — triggered from the
  **Pricing Master** page (`/admin/pricing-master`), Owner / CEO only.
- The sync reads with the Google **service account** — the workbook does
  not need to be shared publicly.

## Header row (row 1)

Put these column headers in **row 1**, lower-case. Rows are matched by
**header name**, not column position, so the order can change and extra
columns are ignored.

| Column | Required | Type | Notes |
|---|---|---|---|
| `active` | – | boolean | `TRUE`/`FALSE` (also 1/0, yes/no, ใช่). Blank → `TRUE`. |
| `service_code` | **yes** | text | Unique key. Upsert matches on this. |
| `brand` | – | text | Blank → `CARE_U`. |
| `branch_scope` | – | text | `ALL` or a branch code (e.g. `C24`). Blank → `ALL`. |
| `category_th` | **yes** | text | Thai category, e.g. `กางเกง`. |
| `subcategory_th` | – | text | Thai subcategory, e.g. `เปลี่ยนซิป`. |
| `service_name_th` | **yes** | text | Thai service name shown to staff/customer. |
| `quote_mode` | **yes** | enum | `AUTO_QUOTE` · `GUIDED_QUOTE` · `MANUAL_QUOTE`. |
| `base_price` | – | number | AUTO: the fixed price. ฿ / commas tolerated. |
| `min_price` | – | number | GUIDED: low end of the range. |
| `max_price` | – | number | GUIDED: high end of the range. |
| `unit` | – | text | Blank → `ตัว`. |
| `default_qty` | – | number | Blank/≤0 → `1`. |
| `difficulty_level` | – | text | e.g. `STANDARD`, `HARD`. |
| `material_group` | – | text | e.g. `ผ้าธรรมดา`, `ยีนส์`. |
| `urgent_allowed` | – | boolean | Blank → `TRUE`. |
| `urgent_fee_per_item` | – | number | Blank → `30`. Always a SEPARATE line ("คิวงานด่วน"). |
| `promo_eligible` | – | boolean | Blank → `TRUE`. |
| `requires_human_verify` | – | boolean | Blank → `FALSE`. GUIDED/MANUAL always verify regardless. |
| `guide_questions` | – | list | JSON array `["q1","q2"]` **or** one question per line. |
| `customer_note_th` | – | text | Shown to the customer / pre-fills the item detail. |
| `staff_note_th` | – | text | Internal note for staff/technician. |
| `sort_order` | – | integer | Blank → `999`. Lower sorts first. |
| `version` | – | text | Blank → `v1`. |
| `last_updated_by` | – | text | Sheet-only metadata — **not** stored in the table. |
| `synced_at` | – | text | Sheet-only display — the route stamps the table's `synced_at` itself. |

## Quote modes

- **AUTO_QUOTE** — standard job. Quote = `base_price × qty`, plus a
  separate `คิวงานด่วน` line when urgent is selected. Instant total.
- **GUIDED_QUOTE** — complicated job. Returns a `min_price`–`max_price`
  range and `guide_questions`; always requires human verification.
- **MANUAL_QUOTE** — owner/technician must evaluate first. No computed
  price; the intake form shows *"ต้องประเมินโดยเจ้าของ/ช่างก่อนยืนยันราคา"*.

## Sync behaviour

1. Reads every data row of `Service_Prices`.
2. Validates required fields (`service_code`, `category_th`,
   `service_name_th`, `quote_mode`) and the `quote_mode` enum.
3. Parses booleans, numbers, and `guide_questions` (JSON or newline list).
4. Upserts into `service_price_master` keyed on `service_code`
   (`source = GOOGLE_SHEET`, `synced_at = now()`).
5. Returns a summary: `inserted`, `updated`, `skipped`, `errors[]`.

Invalid rows are **skipped** and reported in `errors` — they never abort
the rest of the sync. A duplicate `service_code` within the sheet keeps
the last occurrence.

## Permissions

- View Pricing Master + run sync: **Owner / CEO (hq_admin)**.
- Other roles: blocked from the page; the sync route also rejects a
  non-owner session.
- Staff **consume** active prices during intake (the optional service
  picker) — they cannot edit or sync.
