"use client";

import { branches } from "@/lib/brandConfig";

export type ReportRange = "today" | "month" | "year" | "all";

export type ReportFilterState = {
  range: ReportRange;
  branchId: string | "all";
};

interface ReportFiltersProps {
  value: ReportFilterState;
  onChange: (next: ReportFilterState) => void;
  /** Hide the branch selector for reports that always run org-wide. */
  hideBranch?: boolean;
}

const RANGE_LABELS: Record<ReportRange, string> = {
  today: "วันนี้",
  month: "เดือนนี้",
  year: "ปีนี้",
  all: "ทั้งหมด",
};

export function ReportFilters({
  value,
  onChange,
  hideBranch,
}: ReportFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <div className="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden">
        {(["today", "month", "year", "all"] as ReportRange[]).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onChange({ ...value, range: r })}
            className={`px-3 py-1.5 text-sm font-medium ${
              value.range === r
                ? "bg-green-700 text-white"
                : "text-gray-700 hover:bg-green-50"
            }`}
          >
            {RANGE_LABELS[r]}
          </button>
        ))}
      </div>
      {!hideBranch && (
        <select
          value={value.branchId}
          onChange={(e) =>
            onChange({ ...value, branchId: e.target.value as "all" | string })
          }
          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          aria-label="branch filter"
        >
          <option value="all">ทุกสาขา</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.shortLabel}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
