"use client";

import React from "react";
import { PRINT_MODE_LABELS, type PrintMode } from "@/lib/printService";

const MODES: PrintMode[] = ["a4", "thermal", "mobile"];

type Props = {
  value: PrintMode;
  onChange: (mode: PrintMode) => void;
  language?: "th" | "en";
};

/**
 * Compact pill selector shown in the receipt page action bar. Swaps which
 * receipt template renders inside #careu-receipt-card. The actual printer
 * page-size swap happens via the body class set by lib/printService.
 */
export function PrintModeSelector({
  value,
  onChange,
  language = "th",
}: Props) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden">
      {MODES.map((mode) => {
        const isActive = mode === value;
        const label = PRINT_MODE_LABELS[mode][language];
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            className={`px-3 py-1.5 text-xs font-medium transition ${
              isActive
                ? "bg-green-700 text-white"
                : "text-gray-700 hover:bg-green-50"
            }`}
            aria-pressed={isActive}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export default PrintModeSelector;
