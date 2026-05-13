// Sheet sync adapter scaffolding.
//
// Each adapter encapsulates: which Google Sheet tab it reads, how to parse
// rows, and how to upsert them into Supabase. The implementations below are
// intentionally stubs — only the Expense_Log shape is fleshed out enough to
// validate the contract. Wire them up in app/api/sync-<name>/route.ts when
// the corresponding Supabase target is ready.
//
// Existing /api/sync-customers does NOT use this layer yet (it predates the
// adapter design); migrating it is an opportunity for a future refactor, not
// a prerequisite for the expense / summary sync work.

import type { ExpenseRow } from "@/lib/expenses";

export type SyncResult = {
  inserted: number;
  matchedExisting: number;
  skipped: number;
  error: string | null;
};

export interface SheetSyncAdapter<TRow> {
  /** Tab name inside the workbook (e.g. "Expense_Log"). */
  readonly sheetName: string;
  /** Parse the CSV text returned by the gviz endpoint into typed rows. */
  parse(csv: string): TRow[];
  /** Upsert into the corresponding Supabase target. */
  upsert(rows: TRow[]): Promise<SyncResult>;
}

// ---- Expense_Log adapter (stub) ------------------------------------------

export type ParsedExpense = Pick<
  ExpenseRow,
  | "expense_date"
  | "category"
  | "description"
  | "amount"
  | "branch_id"
  | "payment_method"
  | "notes"
>;

export const expenseLogAdapter: SheetSyncAdapter<ParsedExpense> = {
  sheetName: "Expense_Log",
  parse(_csv: string): ParsedExpense[] {
    // TODO: parse Expense_Log columns and map category labels to internal
    // ExpenseCategoryKey. For now we return an empty list so any caller that
    // happens to wire this up early returns a no-op SyncResult rather than
    // crashing.
    return [];
  },
  async upsert(rows: ParsedExpense[]): Promise<SyncResult> {
    return {
      inserted: 0,
      matchedExisting: 0,
      skipped: rows.length,
      error:
        "Expense_Log sync ยังไม่ได้เปิดใช้ — ใช้ /expenses เพื่อเพิ่มรายการมือก่อน",
    };
  },
};

// ---- Daily_Summary adapter (stub) ----------------------------------------

export type DailySummaryRow = {
  summary_date: string;
  branch_id: string | null;
  revenue: number;
  expense: number;
  orders: number;
};

export const dailySummaryAdapter: SheetSyncAdapter<DailySummaryRow> = {
  sheetName: "Daily_Summary",
  parse(_csv: string): DailySummaryRow[] {
    return [];
  },
  async upsert(rows: DailySummaryRow[]): Promise<SyncResult> {
    return {
      inserted: 0,
      matchedExisting: 0,
      skipped: rows.length,
      error: "Daily_Summary sync placeholder — implement in next phase",
    };
  },
};

// ---- Monthly_Summary adapter (stub) --------------------------------------

export type MonthlySummaryRow = {
  year: number;
  month: number;
  branch_id: string | null;
  revenue: number;
  expense: number;
  net_profit: number;
};

export const monthlySummaryAdapter: SheetSyncAdapter<MonthlySummaryRow> = {
  sheetName: "Monthly_Summary",
  parse(_csv: string): MonthlySummaryRow[] {
    return [];
  },
  async upsert(rows: MonthlySummaryRow[]): Promise<SyncResult> {
    return {
      inserted: 0,
      matchedExisting: 0,
      skipped: rows.length,
      error: "Monthly_Summary sync placeholder — implement in next phase",
    };
  },
};

export const adapters = [
  expenseLogAdapter,
  dailySummaryAdapter,
  monthlySummaryAdapter,
] as const;
