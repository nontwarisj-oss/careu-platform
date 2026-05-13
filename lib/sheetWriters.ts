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
  insertFormattedRow,
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
    return { sheet: config.name, rowIndex: -1, formatted: false };
  }
  const result: InsertFormattedRowResult = await insertFormattedRow(
    config.name,
    values,
    {
      templateRowIndex: config.templateRowIndex,
      columnCount: config.columnCount,
    }
  );
  return { sheet: config.name, rowIndex: result.rowIndex, formatted: true };
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
 * Write one order to the Front_Desk tab. Columns M / N / O (checkboxes
 * and Archive) are intentionally left blank so the template-row checkbox
 * data validation propagates the UNCHECKED default.
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
