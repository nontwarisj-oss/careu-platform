"use client";

import { ReactNode } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";

interface ReportFrameProps {
  /** Section caption ("CareU OPS — Reports"). */
  eyebrow?: string;
  /** Big page title (e.g. "รายงานรายรับ"). */
  title: string;
  /** Subtitle / description directly under the title. */
  description?: string;
  /** Optional toolbar slot (filters etc) — rendered top-right. */
  toolbar?: ReactNode;
  /** Body content. */
  children: ReactNode;
  /** When true, also hides the toolbar in print output. */
  printable?: boolean;
  /** Optional CSV export callback — shows a "ดาวน์โหลด CSV" button. */
  onExportCsv?: () => void;
  /** Disable the CSV button (e.g. while data loads or when empty). */
  exportDisabled?: boolean;
}

export function ReportFrame({
  eyebrow = "CareU OPS • Reports",
  title,
  description,
  toolbar,
  children,
  printable = true,
  onExportCsv,
  exportDisabled,
}: ReportFrameProps) {
  const handlePrint = () => {
    if (typeof window === "undefined") return;
    window.print();
  };

  return (
    <RouteGuard page="reports">
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-5 md:mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between border-l-4 border-yellow-400 pl-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            {eyebrow}
          </p>
          <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
            {title}
          </h1>
          {description && (
            <p className="text-sm text-gray-600 mt-1">{description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {toolbar}
          {onExportCsv && (
            <button
              type="button"
              onClick={onExportCsv}
              disabled={exportDisabled}
              className="rounded-lg bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white px-3 py-1.5 text-sm font-medium print:hidden"
            >
              ดาวน์โหลด CSV
            </button>
          )}
          {printable && (
            <button
              type="button"
              onClick={handlePrint}
              className="rounded-lg border border-green-600 text-green-700 hover:bg-green-50 px-3 py-1.5 text-sm font-medium print:hidden"
            >
              พิมพ์ / PDF
            </button>
          )}
          <Link
            href="/reports"
            className="rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 px-3 py-1.5 text-sm font-medium print:hidden"
          >
            รายงานทั้งหมด
          </Link>
        </div>
      </div>

      <div className="space-y-5">{children}</div>

      <p className="mt-6 text-[11px] text-gray-500 print:hidden">
        * พิมพ์เป็น PDF ผ่านเบราว์เซอร์ได้ทันที — Excel export ต่อยอดในเฟสถัดไป
      </p>
    </div>
    </RouteGuard>
  );
}
