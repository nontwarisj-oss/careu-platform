import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import {
  importCustomerRows,
  type ParsedCustomerRow,
} from "@/lib/customerImport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Source of truth: Google Sheet "Data_Center". The sheet must be shared
// "Anyone with the link" for this public CSV export to succeed.
const SHEET_ID = "1m1CEANwJLAXhw3Y1wtRoCS99Dplj8AuW_9aOtZ_iza4";
const SHEET_NAME = "Data_Center";

// Headers we will accept when locating name and phone columns. The matcher
// looks for exact (case-insensitive) matches first, then substring matches.
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

export async function POST() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
    SHEET_NAME
  )}`;

  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch sheet: ${(err as Error).message}` },
      { status: 502 }
    );
  }
  if (!res.ok) {
    return NextResponse.json(
      {
        error: `Sheet fetch returned HTTP ${res.status}. Make sure the sheet is shared "Anyone with the link".`,
      },
      { status: 502 }
    );
  }

  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) {
    return NextResponse.json(
      { error: "Sheet has no data rows under Data_Center." },
      { status: 400 }
    );
  }

  const headerCells = splitCsvLine(lines[0]).map((h) => h.trim());
  const nameIdx = findHeaderIndex(headerCells, NAME_HEADERS);
  const phoneIdx = findHeaderIndex(headerCells, PHONE_HEADERS);

  if (nameIdx === -1 || phoneIdx === -1) {
    return NextResponse.json(
      {
        error: `Could not locate name/phone columns. Found headers: ${headerCells.join(
          ", "
        )}`,
      },
      { status: 400 }
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
    return NextResponse.json({ error: branchError.message }, { status: 500 });
  }
  const firstBranch = branches?.[0] as { id: string } | undefined;
  if (!firstBranch) {
    return NextResponse.json(
      {
        error:
          "No branch found. Seed at least one row in public.branches before syncing customers.",
      },
      { status: 400 }
    );
  }

  const result = await importCustomerRows(rows, firstBranch.id);
  if (result.error) {
    return NextResponse.json(
      { ...result, error: result.error },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    source: "Data_Center",
    totalRows: rows.length,
    ...result,
  });
}
