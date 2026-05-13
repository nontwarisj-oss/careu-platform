// Declarative per-tab contracts for every Google Sheet tab the platform
// writes to. Single source of truth — route handlers and writers look up
// the column count, template row, and preservation policy here instead of
// inlining numbers.
//
// Adding a new tab:
//   1. Add an entry to SHEET_CONFIGS below.
//   2. Add a corresponding writer in lib/sheetWriters.ts.
//   3. Update docs/GOOGLE_SHEET_SYNC.md with the column contract.

export type SheetColumnSpec = {
  /** A, B, C… spreadsheet column letter for greppability. */
  letter: string;
  /** Header text shown on row 1 of the sheet. */
  header: string;
  /** Internal field key the writer uses to find the value. */
  key: string;
};

export type SheetTabConfig = {
  /** Tab name as it appears in the Google Sheet (case-sensitive). */
  name: string;
  /** Number of columns in the row contract. */
  columnCount: number;
  /**
   * 0-indexed row to copy formatting from when inserting a new row.
   *   • undefined → use the row above the insertion point ("inherit").
   *   • Set to a fixed value to anchor on a canonical template row
   *     (e.g. row index 1 = the first data row beneath the header).
   *
   * The format-preserving path always uses insertDimension+inheritFromBefore
   * AND copyPaste from this index, in that order, so dropdowns / data
   * validation survive even when row 1 is just a header.
   */
  templateRowIndex?: number;
  /**
   * When false, writers fall back to the plain `values.append` path
   * (no formatting preservation). Use this for tabs whose formatting
   * comes entirely from column-range rules (ARRAYFORMULA, column-wide
   * conditional formats) where appendRow already works correctly.
   */
  preserveFormatting: boolean;
  /** Column map. Informational — readers should not depend on order. */
  columns?: readonly SheetColumnSpec[];
};

const FRONT_DESK_COLUMNS: readonly SheetColumnSpec[] = [
  { letter: "A", header: "Date",          key: "date" },
  { letter: "B", header: "Job ID",        key: "job_id" },
  { letter: "C", header: "Customer",      key: "customer_name" },
  { letter: "D", header: "Tel",           key: "customer_phone" },
  { letter: "E", header: "History",       key: "customer_type" },
  { letter: "F", header: "Detail",        key: "detail" },
  { letter: "G", header: "QTY",           key: "quantity" },
  { letter: "H", header: "Price",         key: "price" },
  { letter: "I", header: "Pay Status",    key: "payment_status" },
  { letter: "J", header: "Tech",          key: "tech" },
  { letter: "K", header: "Job Status",    key: "job_status" },
  { letter: "L", header: "วันนัด/ด่วน",   key: "urgent" },
  { letter: "M", header: "checkbox",      key: "checkbox_m" },
  { letter: "N", header: "checkbox",      key: "checkbox_n" },
  { letter: "O", header: "Archive",       key: "archive" },
];

const PRICING_COLUMNS: readonly SheetColumnSpec[] = [
  { letter: "A", header: "snapshot_at",          key: "snapshot_at" },
  { letter: "B", header: "service_code",         key: "service_code" },
  { letter: "C", header: "category",             key: "category" },
  { letter: "D", header: "display_name",         key: "display_name" },
  { letter: "E", header: "description",          key: "description" },
  { letter: "F", header: "pricing_type",         key: "pricing_type" },
  { letter: "G", header: "base_price",           key: "base_price" },
  { letter: "H", header: "urgent_fee_default",   key: "urgent_fee_default" },
  { letter: "I", header: "branch_id",            key: "branch_id" },
  { letter: "J", header: "brand_id",             key: "brand_id" },
  { letter: "K", header: "effective_from",       key: "effective_from" },
  { letter: "L", header: "effective_to",         key: "effective_to" },
  { letter: "M", header: "created_by",           key: "created_by" },
];

const DEBUG_COLUMNS: readonly SheetColumnSpec[] = [
  { letter: "A", header: "stamp",   key: "stamp" },
  { letter: "B", header: "marker",  key: "marker" },
  { letter: "C", header: "note",    key: "note" },
];

const EXPENSE_LOG_COLUMNS: readonly SheetColumnSpec[] = [
  { letter: "A", header: "expense_date",    key: "expense_date" },
  { letter: "B", header: "category",        key: "category" },
  { letter: "C", header: "description",     key: "description" },
  { letter: "D", header: "amount",          key: "amount" },
  { letter: "E", header: "branch_code",     key: "branch_code" },
  { letter: "F", header: "payment_method",  key: "payment_method" },
  { letter: "G", header: "notes",           key: "notes" },
];

export const SHEET_CONFIGS = {
  front_desk: {
    name: "Front_Desk",
    columnCount: 15,
    // Row index 1 (0-indexed) — i.e. the second row in the sheet UI,
    // which is the first real data row beneath the header. Copying
    // formatting from there gives every new row the correct dropdown
    // for Pay Status / Job Status and the checkbox config for M / N / O.
    templateRowIndex: 1,
    preserveFormatting: true,
    columns: FRONT_DESK_COLUMNS,
  },
  pricing: {
    name: "Pricing",
    columnCount: 13,
    templateRowIndex: 1,
    preserveFormatting: true,
    columns: PRICING_COLUMNS,
  },
  debug: {
    name: "Debug",
    columnCount: 3,
    // No template — Debug tab is diagnostic-only, no formatting to preserve.
    preserveFormatting: false,
    columns: DEBUG_COLUMNS,
  },
  expense_log: {
    name: "Expense_Log",
    columnCount: 7,
    templateRowIndex: 1,
    preserveFormatting: true,
    columns: EXPENSE_LOG_COLUMNS,
  },
} as const satisfies Record<string, SheetTabConfig>;

export type SheetConfigKey = keyof typeof SHEET_CONFIGS;

export function getSheetConfig(
  key: SheetConfigKey | string
): SheetTabConfig | null {
  if (key in SHEET_CONFIGS) {
    return SHEET_CONFIGS[key as SheetConfigKey];
  }
  // Allow lookup by tab name too — handy for config-from-env-var cases.
  const byName = Object.values(SHEET_CONFIGS).find(
    (c) => c.name === key
  );
  return byName ?? null;
}
