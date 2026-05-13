import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { branches } from "@/lib/brandConfig";
import {
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  type ExpenseCategoryKey,
  type PaymentMethodKey,
} from "@/lib/expenses";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Source workbook (same as the customer sync). Adjust SHEET_ID via env if it
// ever needs to point elsewhere; we keep a default so the route works without
// extra config in production.
const SHEET_ID =
  process.env.EXPENSE_SHEET_ID ??
  "1m1CEANwJLAXhw3Y1wtRoCS99Dplj8AuW_9aOtZ_iza4";
const SHEET_NAME = "Expense_Log";

// ---- CSV parsing (quote-aware, identical shape to /api/sync-customers) ---

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

// ---- Header matching -----------------------------------------------------

const HEADERS = {
  date: ["date", "expense_date", "วันที่"],
  category: ["category", "หมวด", "ประเภท", "หมวดค่าใช้จ่าย"],
  description: ["description", "รายการ", "รายละเอียด"],
  amount: ["amount", "จำนวน", "บาท", "yod", "ยอด"],
  branch: ["branch", "branch_id", "สาขา"],
  payment: ["payment", "payment_method", "วิธีชำระ", "ช่องทาง"],
  notes: ["notes", "หมายเหตุ", "remark"],
  createdBy: ["created_by", "by", "ผู้บันทึก"],
};

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

// ---- Value coercions -----------------------------------------------------

function coerceCategory(value: string): ExpenseCategoryKey | null {
  if (!value) return null;
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  const exactCode = EXPENSE_CATEGORIES.find(
    (c) => c.code === lower || c.code === trimmed
  );
  if (exactCode) return exactCode.code;
  const byLabel = EXPENSE_CATEGORIES.find(
    (c) => c.labelTh === trimmed || c.labelEn.toLowerCase() === lower
  );
  if (byLabel) return byLabel.code;
  const byContains = EXPENSE_CATEGORIES.find(
    (c) => trimmed.includes(c.labelTh) || lower.includes(c.labelEn.toLowerCase())
  );
  return byContains?.code ?? null;
}

function coercePaymentMethod(value: string): PaymentMethodKey | null {
  if (!value) return null;
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  const byCode = PAYMENT_METHODS.find((p) => p.code === lower);
  if (byCode) return byCode.code;
  const byLabel = PAYMENT_METHODS.find((p) => p.labelTh === trimmed);
  if (byLabel) return byLabel.code;
  // Loose contains: "โอน" → transfer, "QR" → promptpay, etc.
  if (lower.includes("transfer") || trimmed.includes("โอน")) return "transfer";
  if (lower.includes("qr") || trimmed.includes("พร้อม")) return "promptpay";
  if (lower.includes("cash") || trimmed.includes("สด")) return "cash";
  if (lower.includes("credit") || trimmed.includes("บัตร")) return "credit_card";
  return "other";
}

function coerceBranchId(value: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  // Direct id match (e.g. "c24-thonburi-market").
  const byId = branches.find((b) => b.id === trimmed);
  if (byId) return byId.id;
  // Address or short label substring (e.g. "ตลาดสดธนบุรี" → c24).
  const byAddress = branches.find(
    (b) =>
      trimmed.includes(b.address) ||
      b.address.includes(trimmed) ||
      lower.includes(b.shortLabel.toLowerCase()) ||
      lower.includes(b.shortName.toLowerCase())
  );
  return byAddress?.id ?? null;
}

function coerceDateIso(value: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  // Already YYYY-MM-DD.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // DD/MM/YYYY or D/M/YYYY (Thai Buddhist or Gregorian)
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (m) {
    let year = Number(m[3]);
    if (year > 2400) year -= 543; // Buddhist → Gregorian
    const month = String(Number(m[2])).padStart(2, "0");
    const day = String(Number(m[1])).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  // Generic fallback via Date parsing.
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${month}-${day}`;
}

function coerceAmount(value: string): number {
  if (!value) return 0;
  const cleaned = value.replace(/[฿,\s]/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// ---- Route handler -------------------------------------------------------

type SyncResult = {
  ok: boolean;
  inserted: number;
  matchedExisting: number;
  skipped: number;
  totalRows: number;
  source: string;
  error?: string;
};

export async function POST(): Promise<NextResponse<SyncResult>> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
    SHEET_NAME
  )}`;

  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        inserted: 0,
        matchedExisting: 0,
        skipped: 0,
        totalRows: 0,
        source: SHEET_NAME,
        error: `Failed to fetch sheet: ${(err as Error).message}`,
      },
      { status: 502 }
    );
  }
  if (!res.ok) {
    return NextResponse.json(
      {
        ok: false,
        inserted: 0,
        matchedExisting: 0,
        skipped: 0,
        totalRows: 0,
        source: SHEET_NAME,
        error: `Sheet fetch HTTP ${res.status}. ตรวจสอบว่า Sheet เปิดสิทธิ์ "Anyone with the link" แล้ว`,
      },
      { status: 502 }
    );
  }

  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) {
    return NextResponse.json({
      ok: false,
      inserted: 0,
      matchedExisting: 0,
      skipped: 0,
      totalRows: 0,
      source: SHEET_NAME,
      error: "ไม่มีข้อมูลภายใต้ Expense_Log",
    });
  }

  const headerCells = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = {
    date: findHeaderIndex(headerCells, HEADERS.date),
    category: findHeaderIndex(headerCells, HEADERS.category),
    description: findHeaderIndex(headerCells, HEADERS.description),
    amount: findHeaderIndex(headerCells, HEADERS.amount),
    branch: findHeaderIndex(headerCells, HEADERS.branch),
    payment: findHeaderIndex(headerCells, HEADERS.payment),
    notes: findHeaderIndex(headerCells, HEADERS.notes),
    createdBy: findHeaderIndex(headerCells, HEADERS.createdBy),
  };

  if (idx.date === -1 || idx.amount === -1 || idx.category === -1) {
    return NextResponse.json(
      {
        ok: false,
        inserted: 0,
        matchedExisting: 0,
        skipped: 0,
        totalRows: 0,
        source: SHEET_NAME,
        error: `ขาดคอลัมน์หลัก (date / category / amount). Found headers: ${headerCells.join(", ")}`,
      },
      { status: 400 }
    );
  }

  type Parsed = {
    expense_date: string;
    category: string;
    description: string | null;
    amount: number;
    branch_id: string | null;
    payment_method: string | null;
    notes: string | null;
    created_by: string | null;
  };

  const parsed: Parsed[] = [];
  let skipped = 0;

  for (const line of lines.slice(1)) {
    const values = splitCsvLine(line);
    const date = coerceDateIso(values[idx.date] ?? "");
    const categoryRaw = values[idx.category] ?? "";
    const category = coerceCategory(categoryRaw);
    const amount = coerceAmount(values[idx.amount] ?? "");

    if (!date || !category || amount <= 0) {
      skipped += 1;
      continue;
    }

    parsed.push({
      expense_date: date,
      category,
      description:
        idx.description >= 0 ? (values[idx.description] ?? "").trim() || null : null,
      amount,
      branch_id:
        idx.branch >= 0 ? coerceBranchId(values[idx.branch] ?? "") : null,
      payment_method:
        idx.payment >= 0 ? coercePaymentMethod(values[idx.payment] ?? "") : null,
      notes: idx.notes >= 0 ? (values[idx.notes] ?? "").trim() || null : null,
      created_by:
        idx.createdBy >= 0 ? (values[idx.createdBy] ?? "").trim() || null : null,
    });
  }

  if (parsed.length === 0) {
    return NextResponse.json({
      ok: true,
      inserted: 0,
      matchedExisting: 0,
      skipped,
      totalRows: lines.length - 1,
      source: SHEET_NAME,
    });
  }

  // Dedup by (date + amount + description + branch). Anything already present
  // with that signature stays put — Expense_Log is append-only on the sheet
  // side so partial sync runs don't double-import.
  const { data: existing, error: existingErr } = await supabase
    .from("expenses")
    .select("expense_date, amount, description, branch_id");

  if (existingErr) {
    if (/relation .* does not exist|schema cache/i.test(existingErr.message)) {
      return NextResponse.json(
        {
          ok: false,
          inserted: 0,
          matchedExisting: 0,
          skipped,
          totalRows: lines.length - 1,
          source: SHEET_NAME,
          error: "ยังไม่ได้รัน migration 20260518_expense_log.sql",
        },
        { status: 500 }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        inserted: 0,
        matchedExisting: 0,
        skipped,
        totalRows: lines.length - 1,
        source: SHEET_NAME,
        error: existingErr.message,
      },
      { status: 500 }
    );
  }

  const seen = new Set<string>();
  for (const r of (existing ?? []) as Array<{
    expense_date: string;
    amount: number;
    description: string | null;
    branch_id: string | null;
  }>) {
    const key = `${r.expense_date}|${Number(r.amount).toFixed(2)}|${
      r.description ?? ""
    }|${r.branch_id ?? ""}`;
    seen.add(key);
  }

  const fresh: Parsed[] = [];
  let matchedExisting = 0;
  for (const row of parsed) {
    const key = `${row.expense_date}|${row.amount.toFixed(2)}|${
      row.description ?? ""
    }|${row.branch_id ?? ""}`;
    if (seen.has(key)) {
      matchedExisting += 1;
      continue;
    }
    seen.add(key);
    fresh.push(row);
  }

  if (fresh.length === 0) {
    return NextResponse.json({
      ok: true,
      inserted: 0,
      matchedExisting,
      skipped,
      totalRows: lines.length - 1,
      source: SHEET_NAME,
    });
  }

  const insertRes = await supabase.from("expenses").insert(fresh);
  if (insertRes.error) {
    return NextResponse.json(
      {
        ok: false,
        inserted: 0,
        matchedExisting,
        skipped,
        totalRows: lines.length - 1,
        source: SHEET_NAME,
        error: insertRes.error.message,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    inserted: fresh.length,
    matchedExisting,
    skipped,
    totalRows: lines.length - 1,
    source: SHEET_NAME,
  });
}
