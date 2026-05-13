"use client";

import React from "react";

type Tone = "primary" | "secondary" | "danger" | "neutral";

const TONE_CLASSES: Record<Tone, string> = {
  primary:
    "bg-green-700 hover:bg-green-800 text-white border-green-700 disabled:bg-green-700/60",
  secondary:
    "bg-white hover:bg-green-50 text-green-800 border-green-300 disabled:bg-gray-50 disabled:text-gray-400",
  danger:
    "bg-white hover:bg-red-50 text-red-700 border-red-300 disabled:bg-gray-50 disabled:text-gray-400",
  neutral:
    "bg-white hover:bg-gray-50 text-gray-700 border-gray-300 disabled:bg-gray-50 disabled:text-gray-400",
};

interface QuickActionButtonProps {
  /** Primary visible label — short verb phrase. */
  label: string;
  /** Optional sub-label rendered below the main label on wider buttons. */
  hint?: string;
  /** Optional icon path data for the leading icon. */
  iconPath?: string;
  tone?: Tone;
  /** Marks the action as currently running. */
  loading?: boolean;
  disabled?: boolean;
  /** When true, render `<a>` instead of `<button>`. */
  href?: string;
  onClick?: () => void | Promise<void>;
  /** When true, the button becomes a full-width touch target — tablet-friendly. */
  block?: boolean;
  /** Extra Tailwind classes. */
  className?: string;
  /** Hide on print (default true — these buttons are operational chrome). */
  hideOnPrint?: boolean;
}

/**
 * Operational quick-action button. Single source of truth for the
 * touch-target shape (≥ 44 px), tone palette, and loading state used across
 * the storefront. Use this for: print receipt, send LINE, mark ready, assign
 * technician, re-sync sheet, etc.
 */
export function QuickActionButton({
  label,
  hint,
  iconPath,
  tone = "secondary",
  loading,
  disabled,
  href,
  onClick,
  block,
  className,
  hideOnPrint = true,
}: QuickActionButtonProps) {
  const baseClass = `inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition shadow-sm min-h-[44px] active:scale-[0.98] disabled:cursor-not-allowed ${
    TONE_CLASSES[tone]
  } ${block ? "w-full" : ""} ${hideOnPrint ? "print:hidden" : ""} ${
    className ?? ""
  }`;

  const content = (
    <>
      {iconPath ? (
        <svg
          viewBox="0 0 24 24"
          className="w-5 h-5 shrink-0"
          fill="currentColor"
          aria-hidden
        >
          <path d={iconPath} />
        </svg>
      ) : null}
      <span className="flex flex-col items-start leading-tight">
        <span>{loading ? "..." : label}</span>
        {hint ? (
          <span className="text-[10px] font-normal opacity-75">{hint}</span>
        ) : null}
      </span>
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        className={baseClass}
        aria-disabled={disabled || loading}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (disabled || loading) return;
        void onClick?.();
      }}
      disabled={disabled || loading}
      className={baseClass}
    >
      {content}
    </button>
  );
}

/** Common icon path data so callers don't have to re-discover it. */
export const QUICK_ACTION_ICONS = {
  print:
    "M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z",
  send:
    "M2.01 21L23 12 2.01 3 2 10l15 2-15 2z",
  ready:
    "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  assign:
    "M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
  resync:
    "M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8c-.45-.83-.7-1.79-.7-2.8 0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z",
} as const;
