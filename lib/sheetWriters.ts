// Domain-level Google Sheet writers. Each function corresponds to one tab
// contract and converts an in-app object into the exact column array the
// sheet expects. Route handlers should call these — they should never know
// which column is which.
//
// Routing rule:
//   • config.preserveFormatting === true  → insertFormattedRow (batchUpdate)
//   • otherwise                            → appendRow         (values.append)
//
// Failure handling is the caller's responsibility — the writer throws, the
// route handler catches and decides whether to enqueue a retry via
// logSyncFailure / how to surface the error to the UI.
//
// Server-only.

import {
  appendRow,
  findRowByColumnValue,
  insertFormattedRow,
  updateRowValues,
  type SheetCellValue,
  type InsertFormattedRowResult,
} from "@/lib/googleSheets";
import { getSheetConfig, type SheetTabConfig } from "@/lib/sheetConfigs";

export type WriteRowResult = {
  /** Which tab was written. */
  sheet: string;
  /** Row index (0-based) where the data landed. -1 when using plain appendRow. */
  rowIndex: number;
  /** True when the formatting-preserving path was used. */
  formatted: boolean;
  /**
   * "appended" — new row at the bottom (normal happy path / first write).
   * "updated"  — an existing row matched the dedup key and was overwritten.
   *              Operator-managed columns (Front_Desk M/N/O) stay untouched.
   */
  mode: "appended" | "updated";
};

async function writeRow(
  config: SheetTabConfig,
  values: SheetCellValue[]
): Promise<WriteRowResult> {
  if (!config.preserveFormatting) {
    // Coerce booleans → string for appendRow's narrower signature.
    const coerced: Array<string | number | null> = values.map((v) => {
      if (v === undefined || v === null) return null;
      if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
      return v;
    });
    await appendRow(config.name, coerced);
    return { sheet: config.name, rowIndex: -1, formatted: false, mode: "appended" };
  }
  const result: InsertFormattedRowResult = await insertFormattedRow(
    config.name,
    values,
    {
      templateRowIndex: config.templateRowIndex,
      columnCount: config.columnCount,
    }
  );
  return {
    sheet: config.name,
    rowIndex: result.rowIndex,
    formatted: true,
    mode: "appended",
  };
}

// ---------- Front_Desk (orders) -------------------------------------------

export type OrderRowValues = {
  date: string;
  jobId: string;
  customerName: string;
  customerPhone: string;
  customerType: string;
  detail: string;
  quantity: number;
  price: number;
  paymentStatus: string;
  tech: string;
  jobStatus: string;
  urgent: string;
};

/**
 * Write one order to the Front_Desk tab.
 *
 * Dedup contract: Job ID lives in column B and is the dedup key. Before
 * appending, we scan column B for a row with the same id. If found we
 * UPDATE that row in place; columns M / N / O (operator checkboxes and
 * Archive flag) are preserved — they belong to the staff workflow on the
 * sheet, not to the platform. If not found we fall through to the normal
 * append path (formatting preserved via insertFormattedRow).
 *
 * `input.jobId` must be a non-empty string for dedup to engage. The
 * caller is responsible for stable id derivation (we use the first 8
 * chars of order.id uppercased, see /api/sync-order-to-sheet/route.ts).
 */
export async function writeOrderRow(input: OrderRowValues): Promise<WriteRowResult> {
  const config = getSheetConfig("front_desk");
  if (!config) throw new Error('Sheet config "front_desk" missing');
  // The order MUST match SHEET_CONFIGS.front_desk.columns (A..O).
  const values: SheetCellValue[] = [
    input.date,           // A Date
    input.jobId,          // B Job ID
    input.customerName,   // C Customer
    input.customerPhone,  // D Tel
    input.customerType,   // E History
    input.detail,         // F Detail
    input.quantity,       // G QTY
    input.price,          // H Price
    input.paymentStatus,  // I Pay Status
    input.tech,           // J Tech
    input.jobStatus,      // K Job Status
    input.urgent,         // L วันนัด/ด่วน
    "",                   // M checkbox
    "",                   // N checkbox
    "",                   // O Archive
  ];

  const trimmedJobId = input.jobId.trim();
  if (trimmedJobId.length > 0) {
    try {
      const existing = await findRowByColumnValue(
        config.name,
        "B",
        trimmedJobId
      );
      if (existing >= 0) {
        // Update in place; preserve operator-managed columns M (12), N (13),
        // O (14). The values for those slots are already empty strings, but
        // we pass preservedColumns explicitly so updateRowValues skips the
        // PUT for that column range entirely.
        await updateRowValues(config.name, existing, values, {
          preservedColumns: [12, 13, 14],
        });
        return {
          sheet: config.name,
          rowIndex: existing,
          formatted: true,
          mode: "updated",
        };
      }
    } catch (err) {
      // A lookup failure must not block the write — fall through to the
      // normal append path so the order still lands somewhere. The caller
      // observes the resulting `mode: "appended"` and can decide whether
      // to flag the lookup error to admins separately. We do NOT silently
      // swallow: log once with structured context so it's greppable.
      console.warn(
        `[sheetWriters.writeOrderRow] dedup lookup failed — falling back to append. id=${trimmedJobId} reason=${
          (err as Error).message ?? String(err)
        }`
      );
    }
  }

  return writeRow(config, values);
}

// ---------- Pricing (snapshot dump) ---------------------------------------

export type PricingRowValues = {
  snapshotAt: string;
  serviceCode: string;
  categoryLabel: string;
  displayName: string;
  description: string;
  pricingType: string;
  basePrice: number | "";
  urgentFeeDefault: number;
  branchId: string;
  brandId: string;
  effectiveFrom: string;
  effectiveTo: string;
  createdBy: string;
};

/**
 * Pricing rows are append-only snapshots — each press of "Sync to Sheet"
 * adds a fresh `snapshot_at` row by design. No dedup here.
 */
export async function writePricingRow(
  input: PricingRowValues
): Promise<WriteRowResult> {
  const config = getSheetConfig("pricing");
  if (!config) throw new Error('Sheet config "pricing" missing');
  const values: SheetCellValue[] = [
    input.snapshotAt,        // A snapshot_at
    input.serviceCode,       // B service_code
    input.categoryLabel,     // C category
    input.displayName,       // D display_name
    input.description,       // E description
    input.pricingType,       // F pricing_type
    input.basePrice,         // G base_price
    input.urgentFeeDefault,  // H urgent_fee_default
    input.branchId,          // I branch_id
    input.brandId,           // J brand_id
    input.effectiveFrom,     // K effective_from
    input.effectiveTo,       // L effective_to
    input.createdBy,         // M created_by
  ];
  return writeRow(config, values);
}

// ---------- Debug (diagnostic only) ---------------------------------------

export async function writeDebugRow(
  values: [string, string, string]
): Promise<WriteRowResult> {
  const config = getSheetConfig("debug");
  if (!config) throw new Error('Sheet config "debug" missing');
  return writeRow(config, values as SheetCellValue[]);
}
