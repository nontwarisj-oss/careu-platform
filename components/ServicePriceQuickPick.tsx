"use client";

// Optional Pricing Master picker for the intake form.
//
// Purely additive: staff can still type the item name + price by hand as
// before. When a service IS picked here, it fills the existing draft-item
// fields via `onApply` — the intake save path is untouched.
//
//   AUTO_QUOTE   → auto-fills the base price.
//   GUIDED_QUOTE → fills the min price as a starting estimate, shows the
//                  guide questions + staff note, flags "needs human verify".
//   MANUAL_QUOTE → clears the price and shows the manual-evaluation notice.
//
// The urgent fee ("คิวงานด่วน") stays a separate line — this only sets the
// per-item urgent fee; the intake form's existing urgent checkbox + summary
// keep it as its own charge.

import { useMemo, useState } from "react";
import { formatCurrency } from "@/lib/utils";
import {
  calculateServiceQuote,
  URGENT_LINE_LABEL_TH,
  type ServicePrice,
} from "@/lib/servicePriceMaster";

/** Patch applied onto the draft item when a service is picked. */
export type ServicePriceApply = {
  serviceName: string;
  /** "" for MANUAL_QUOTE — staff must enter the price themselves. */
  unitPrice: string;
  urgentFee: string;
  /** customer_note_th, or null to keep the existing detail text. */
  detail: string | null;
};

export function ServicePriceQuickPick({
  services,
  urgent,
  onApply,
}: {
  services: ServicePrice[];
  /** Current urgent state of the draft item — drives the live preview. */
  urgent: boolean;
  onApply: (patch: ServicePriceApply) => void;
}) {
  const [code, setCode] = useState("");

  const selected = useMemo(
    () => services.find((s) => s.serviceCode === code) ?? null,
    [services, code]
  );
  const quote = useMemo(
    () => (selected ? calculateServiceQuote(selected, 1, urgent) : null),
    [selected, urgent]
  );

  // Nothing in the catalog yet → render nothing (manual entry still works).
  if (services.length === 0) return null;

  const handleSelect = (nextCode: string) => {
    setCode(nextCode);
    const svc = services.find((s) => s.serviceCode === nextCode);
    if (!svc) return;
    const unitPrice =
      svc.quoteMode === "AUTO_QUOTE"
        ? svc.basePrice !== null
          ? String(svc.basePrice)
          : ""
        : svc.quoteMode === "GUIDED_QUOTE"
          ? svc.minPrice !== null
            ? String(svc.minPrice)
            : svc.basePrice !== null
              ? String(svc.basePrice)
              : ""
          : ""; // MANUAL_QUOTE — leave blank on purpose
    onApply({
      serviceName: svc.serviceNameTh,
      unitPrice,
      urgentFee: String(svc.urgentFeePerItem),
      detail: svc.customerNoteTh,
    });
  };

  const modeBadge =
    selected?.quoteMode === "AUTO_QUOTE"
      ? "border-green-300 bg-green-100 text-green-800"
      : selected?.quoteMode === "GUIDED_QUOTE"
        ? "border-blue-300 bg-blue-100 text-blue-800"
        : "border-amber-300 bg-amber-100 text-amber-800";

  return (
    <div className="mb-2 rounded-lg border border-green-200 bg-green-50/60 p-2.5">
      <label className="block text-[10px] font-bold uppercase tracking-wide text-green-700 mb-1">
        Pricing Master — เลือกบริการมาตรฐาน (ไม่บังคับ)
      </label>
      <select
        value={code}
        onChange={(e) => handleSelect(e.target.value)}
        className="w-full rounded-lg border border-green-300 bg-white p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
      >
        <option value="">— เลือกจาก Pricing Master / หรือกรอกเองด้านล่าง —</option>
        {services.map((s) => (
          <option key={s.id} value={s.serviceCode}>
            {s.serviceNameTh}
            {s.quoteMode === "AUTO_QUOTE"
              ? ` · ฿${s.basePrice ?? "?"}`
              : s.quoteMode === "GUIDED_QUOTE"
                ? " · ช่วงราคา"
                : " · ประเมินราคา"}
          </option>
        ))}
      </select>

      {selected && quote && (
        <div className="mt-2 space-y-1.5 text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${modeBadge}`}
            >
              {selected.quoteMode}
            </span>
            <span className="text-gray-500">
              {selected.categoryTh}
              {selected.subcategoryTh ? ` · ${selected.subcategoryTh}` : ""}
            </span>
          </div>

          {/* Price summary per quote mode */}
          {selected.quoteMode === "AUTO_QUOTE" && quote.total !== null && (
            <p className="text-gray-700">
              ราคา{" "}
              <span className="font-semibold text-green-700">
                {formatCurrency(selected.basePrice ?? 0)}
              </span>{" "}
              / {selected.unit}
              {quote.urgentApplied && (
                <>
                  {" "}
                  + {URGENT_LINE_LABEL_TH}{" "}
                  <span className="font-semibold text-yellow-700">
                    {formatCurrency(quote.urgentFee)}
                  </span>{" "}
                  = รวม{" "}
                  <span className="font-bold text-green-700">
                    {formatCurrency(quote.total)}
                  </span>
                </>
              )}
            </p>
          )}
          {selected.quoteMode === "GUIDED_QUOTE" &&
            quote.minTotal !== null &&
            quote.maxTotal !== null && (
              <p className="text-gray-700">
                ช่วงราคาประเมิน{" "}
                <span className="font-semibold text-blue-700">
                  {formatCurrency(quote.minTotal)} –{" "}
                  {formatCurrency(quote.maxTotal)}
                </span>{" "}
                ({qtyHintTh(selected)})
              </p>
            )}

          {/* Guide questions (GUIDED_QUOTE) */}
          {quote.guideQuestions.length > 0 && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5">
              <p className="font-semibold text-blue-800 mb-0.5">
                คำถามแนะนำก่อนตีราคา
              </p>
              <ul className="list-disc pl-4 text-blue-900 space-y-0.5">
                {quote.guideQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Staff note */}
          {quote.staffNoteTh && (
            <p className="text-gray-600">
              <span className="font-semibold">โน้ตช่าง:</span>{" "}
              {quote.staffNoteTh}
            </p>
          )}

          {/* Human-verify / manual notice */}
          {quote.requiresHumanVerify && (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 font-medium text-amber-800">
              ⚠{" "}
              {quote.noticeTh ??
                "งานนี้ต้องให้เจ้าของ/ช่างยืนยันราคาก่อน"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Small helper: "ต่อ 1 ตัว" style qty hint for the guided range line. */
function qtyHintTh(service: ServicePrice): string {
  return `ต่อ ${service.defaultQty} ${service.unit}`;
}

export default ServicePriceQuickPick;
