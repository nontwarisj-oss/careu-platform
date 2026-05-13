// Minimal client-side CSV export. Renders rows into a UTF-8 CSV with a BOM
// (so Excel opens Thai text correctly) and triggers a browser download.

export type CsvRow = Record<string, string | number | null | undefined>;

function escapeCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(headers: string[], rows: CsvRow[]): string {
  const headerLine = headers.map(escapeCell).join(",");
  const bodyLines = rows.map((row) =>
    headers.map((h) => escapeCell(row[h])).join(",")
  );
  return [headerLine, ...bodyLines].join("\r\n");
}

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: CsvRow[]
): void {
  if (typeof window === "undefined") return;
  const csv = rowsToCsv(headers, rows);
  // BOM ensures Excel reads UTF-8 Thai correctly.
  const blob = new Blob(["﻿" + csv], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Build a timestamped filename like "careu-revenue-2026-05-13.csv".
 */
export function buildExportFilename(reportKey: string): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `careu-${reportKey}-${y}-${m}-${day}.csv`;
}
