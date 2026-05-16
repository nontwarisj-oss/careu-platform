// Customer sheet sync — fetch the "Data_Center" Google Sheet and import
// any new customers into public.customers.
//
// Extracted in the bug-fix phase so the SAME logic backs both:
//   • the manual "Sync from Google Sheet" button (POST /api/sync-customers)
//   • the hourly cron (GET /api/cron/sync-customers)
//
// Identity is keyed on the canonical Thai phone (lib/phone.ts) — the same
// person never gets a second row. Existing customers are left UNTOUCHED:
// importCustomerRows only INSERTs new rows, so a customer's good visit /
// spend history is never overwritten by a sync.

import supabase from "@/lib/supabase";
import {
  importCustomerRows,
  type ImportResult,
  type ParsedCustomerRow,
} from "@/lib/customerImport";

// Source of truth: Google Sheet "Data_Center". The sheet must be shared
// "Anyone with the link" for this public CSV export to succeed.
const SHEET_ID = "1m1CEANwJLAXhw3Y1wtRoCS99Dplj8AuW_9aOtZ_iza4";
const SHEET_NAME = "Data_Center";

// Headers we will accept when locating name and phone columns.
const NAME_HEADERS = [
  "name",
  "ชื่อ",
  "ชื่อลูกค้า",
  "customer",
  "customer name",
  "full name",
  "fullname",
];
const PHONE_HEADERS = [
  "phone",
  "phone number",
  "tel",
  "mobile",
  "เบอร์",
  "เบอร์โทร",
  "เบอร์โทรศัพท์",
  "โทร",
  "โทรศัพท์",
];

export type SheetSyncResult = ImportResult & {
  ok: boolean;
  /** Total data rows read from the sheet (before dedup/skip). */
  totalRows: number;
  source: string;
  /** HTTP-ish status hint for the caller to map onto a response code. */
  status: number;
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function findHeaderIndex(headers: string[], candidates: string[]): number {
  const norm = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const lc = c.toLowerCase();
    const exact = norm.indexOf(lc);
    if (exact >= 0) return exact;
  }
  for (const c of candidates) {
    const lc = c.toLowerCase();
    const partial = norm.findIndex((h) => h.includes(lc));
    if (partial >= 0) return partial;
  }
  return -1;
}

function fail(
  error: string,
  status: number,
  totalRows = 0
): SheetSyncResult {
  return {
    ok: false,
    inserted: 0,
    skipped: 0,
    matchedExisting: 0,
    error,
    totalRows,
    source: SHEET_NAME,
    status,
  };
}

/**
 * Fetch the Data_Center sheet, parse name/phone columns, and import any
 * customers not already in the system. Deduplicates by canonical phone
 * (against existing rows AND within the batch). Never updates existing
 * customers — only inserts.
 */
export async function syncCustomersFromSheet(): Promise<SheetSyncResult> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
    SHEET_NAME
  )}`;

  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    return fail(`Failed to fetch sheet: ${(err as Error).message}`, 502);
  }
  if (!res.ok) {
    return fail(
      `Sheet fetch returned HTTP ${res.status}. Make sure the sheet is shared "Anyone with the link".`,
      502
    );
  }

  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) {
    return fail("Sheet has no data rows under Data_Center.", 400);
  }

  const headerCells = splitCsvLine(lines[0]).map((h) => h.trim());
  const nameIdx = findHeaderIndex(headerCells, NAME_HEADERS);
  const phoneIdx = findHeaderIndex(headerCells, PHONE_HEADERS);
  if (nameIdx === -1 || phoneIdx === -1) {
    return fail(
      `Could not locate name/phone columns. Found headers: ${headerCells.join(
        ", "
      )}`,
      400
    );
  }

  const rows: ParsedCustomerRow[] = lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return {
      name: (values[nameIdx] ?? "").trim(),
      phone: (values[phoneIdx] ?? "").trim(),
      email: "",
      address: "",
    };
  });

  const { data: branches, error: branchError } = await supabase
    .from("branches")
    .select("id")
    .limit(1);
  if (branchError) {
    return fail(branchError.message, 500, rows.length);
  }
  const firstBranch = branches?.[0] as { id: string } | undefined;
  if (!firstBranch) {
    return fail(
      "No branch found. Seed at least one row in public.branches before syncing customers.",
      400,
      rows.length
    );
  }

  const result = await importCustomerRows(rows, firstBranch.id);
  return {
    ok: !result.error,
    ...result,
    totalRows: rows.length,
    source: SHEET_NAME,
    status: result.error ? 500 : 200,
  };
}
