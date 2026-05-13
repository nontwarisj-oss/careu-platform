"use client";

import { formatCurrency } from "@/lib/utils";

export type BarDatum = {
  label: string;
  value: number;
  /** Optional second value rendered as a secondary line (e.g. expense). */
  secondaryValue?: number;
};

interface SimpleBarChartProps {
  data: BarDatum[];
  /** Format mode for the inline value: currency (default) or plain number. */
  format?: "currency" | "number";
  /** Hide the value label on the right (useful for compact widgets). */
  hideValue?: boolean;
  /** Optional caption shown below when there's no data. */
  emptyMessage?: string;
}

/**
 * Lightweight bar chart implemented in pure Tailwind + CSS — no chart library.
 * Each row scales relative to the largest value in the dataset; secondary
 * values render as a thinner inline strip in yellow so revenue/expense can be
 * compared at a glance.
 */
export function SimpleBarChart({
  data,
  format = "currency",
  hideValue = false,
  emptyMessage = "ยังไม่มีข้อมูล",
}: SimpleBarChartProps) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-gray-500 text-center py-6">{emptyMessage}</p>
    );
  }

  const max = Math.max(1, ...data.map((d) => Math.max(d.value, d.secondaryValue ?? 0)));
  const fmt = (n: number) =>
    format === "currency" ? formatCurrency(n) : n.toLocaleString();

  return (
    <ul className="space-y-2.5">
      {data.map((d) => {
        const pct = Math.round((d.value / max) * 100);
        const secPct =
          typeof d.secondaryValue === "number"
            ? Math.round((d.secondaryValue / max) * 100)
            : null;
        return (
          <li key={d.label} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-gray-700 truncate">{d.label}</span>
              {!hideValue && (
                <span className="font-semibold text-gray-800 whitespace-nowrap">
                  {fmt(d.value)}
                </span>
              )}
            </div>
            <div className="mt-1 h-2.5 w-full rounded-full bg-gray-100 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-green-500 to-yellow-400"
                style={{ width: `${pct}%` }}
              />
            </div>
            {secPct !== null && (
              <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
                <span className="inline-block h-1 w-12 rounded-full bg-yellow-400/80" />
                ค่าใช้จ่าย {fmt(d.secondaryValue ?? 0)} ({secPct}% ของแกน)
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
