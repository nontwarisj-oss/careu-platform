"use client";

// Pricing Master (Phase 2) — read + sync surface for service_price_master.
//
// OWNER / CEO (hq_admin) can view the catalog and run "Sync Service Prices"
// (Google Sheet → Supabase). Other roles are blocked by RouteGuard. Staff
// only consume active prices during intake — never edit here.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RouteGuard } from "@/components/RouteGuard";
import { useLanguage } from "@/lib/languageContext";
import { useRole } from "@/lib/roleContext";
import { canManagePricing } from "@/lib/permissions";
import { formatCurrency } from "@/lib/utils";
import {
  getAllServicePrices,
  QUOTE_MODES,
  QUOTE_MODE_LABELS,
  type QuoteMode,
  type ServicePrice,
} from "@/lib/servicePriceMaster";

const QUOTE_MODE_BADGE: Record<QuoteMode, string> = {
  AUTO_QUOTE: "border-green-300 bg-green-50 text-green-800",
  GUIDED_QUOTE: "border-blue-300 bg-blue-50 text-blue-800",
  MANUAL_QUOTE: "border-amber-300 bg-amber-50 text-amber-800",
};

type SyncResult = {
  ok?: boolean;
  error?: string;
  inserted?: number;
  updated?: number;
  skipped?: number;
  errors?: string[];
  total_rows?: number;
};

export default function PricingMasterPage() {
  return (
    <RouteGuard page="admin">
      <PricingMasterInner />
    </RouteGuard>
  );
}

function PricingMasterInner() {
  const { language } = useLanguage();
  const { role } = useRole();
  const canSync = canManagePricing(role);

  const [services, setServices] = useState<ServicePrice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [modeFilter, setModeFilter] = useState<QuoteMode | "all">("all");

  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);

  const load = useCallback(async () => {
    setIsLoading(true);
    const res = await getAllServicePrices();
    setServices(res.services);
    setLoadError(res.error);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSync = async () => {
    if (!canSync) return;
    setIsSyncing(true);
    setSyncMessage(null);
    setSyncErrors([]);
    try {
      const res = await fetch("/api/admin/pricing-master/sync", {
        method: "POST",
      });
      const json = (await res.json()) as SyncResult;
      if (!res.ok || !json.ok) {
        setSyncMessage(
          language === "th"
            ? `ซิงค์ไม่สำเร็จ: ${json.error ?? `HTTP ${res.status}`}`
            : `Sync failed: ${json.error ?? `HTTP ${res.status}`}`
        );
        setSyncErrors(json.errors ?? []);
      } else {
        setSyncMessage(
          language === "th"
            ? `ซิงค์ราคาเรียบร้อย — เพิ่มใหม่ ${json.inserted ?? 0} • อัปเดต ${
                json.updated ?? 0
              } • ข้าม ${json.skipped ?? 0}`
            : `Prices synced — inserted ${json.inserted ?? 0} • updated ${
                json.updated ?? 0
              } • skipped ${json.skipped ?? 0}`
        );
        setSyncErrors(json.errors ?? []);
        await load();
      }
    } catch (err) {
      setSyncMessage(
        err instanceof Error ? err.message : "Network error during sync"
      );
    }
    setIsSyncing(false);
  };

  const summary = useMemo(() => {
    const byMode = new Map<QuoteMode, number>();
    let activeCount = 0;
    for (const s of services) {
      if (s.active) activeCount += 1;
      byMode.set(s.quoteMode, (byMode.get(s.quoteMode) ?? 0) + 1);
    }
    return { total: services.length, activeCount, byMode };
  }, [services]);

  const visible = useMemo(() => {
    let list = services;
    if (modeFilter !== "all") {
      list = list.filter((s) => s.quoteMode === modeFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) =>
          s.serviceCode.toLowerCase().includes(q) ||
          s.serviceNameTh.toLowerCase().includes(q) ||
          s.categoryTh.toLowerCase().includes(q)
      );
    }
    return list;
  }, [services, search, modeFilter]);

  const priceLabel = (s: ServicePrice): string => {
    if (s.quoteMode === "MANUAL_QUOTE") {
      return language === "th" ? "ประเมินราคา" : "Manual";
    }
    if (s.quoteMode === "GUIDED_QUOTE") {
      const lo = s.minPrice ?? s.basePrice;
      const hi = s.maxPrice ?? s.basePrice;
      if (lo !== null && hi !== null) {
        return `${formatCurrency(lo)} – ${formatCurrency(hi)}`;
      }
      return language === "th" ? "ช่วงราคา" : "Range";
    }
    return s.basePrice !== null ? formatCurrency(s.basePrice) : "—";
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      {/* Header */}
      <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 border-l-4 border-yellow-400 pl-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS
          </p>
          <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
            {language === "th" ? "Pricing Master (เฟส 2)" : "Pricing Master"}
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            {language === "th"
              ? "แคตตาล็อกราคาบริการ — แก้ที่ Google Sheet แล้วกดซิงค์เข้าระบบ"
              : "Service price catalog — edit in Google Sheet, then sync into the system"}
          </p>
          {!canSync && (
            <p className="mt-2 inline-block px-2 py-0.5 rounded-full bg-yellow-50 border border-yellow-200 text-yellow-800 text-[11px] font-semibold">
              {language === "th"
                ? "โหมดดูเท่านั้น — เฉพาะ Owner / CEO ซิงค์ราคาได้"
                : "Read-only — Owner / CEO can sync"}
            </p>
          )}
        </div>
        {canSync && (
          <button
            onClick={() => void handleSync()}
            disabled={isSyncing}
            className="bg-green-700 hover:bg-green-800 text-white px-5 py-2.5 rounded-lg transition font-semibold disabled:opacity-50"
          >
            {isSyncing
              ? language === "th"
                ? "กำลังซิงค์..."
                : "Syncing..."
              : language === "th"
              ? "ซิงค์ราคาจาก Google Sheet"
              : "Sync Service Prices"}
          </button>
        )}
      </div>

      {/* Summary band */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">
            {language === "th" ? "บริการทั้งหมด" : "Total services"}
          </p>
          <p className="mt-1 text-2xl font-bold text-gray-900">
            {summary.total}
          </p>
        </div>
        <div className="rounded-2xl border border-green-100 bg-green-50 p-4 shadow-sm">
          <p className="text-xs text-green-800">
            {language === "th" ? "ใช้งานอยู่" : "Active"}
          </p>
          <p className="mt-1 text-2xl font-bold text-green-900">
            {summary.activeCount}
          </p>
        </div>
        {QUOTE_MODES.map((mode) => (
          <div
            key={mode}
            className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm"
          >
            <p className="text-xs text-gray-500">
              {QUOTE_MODE_LABELS[mode][language === "th" ? "th" : "en"]}
            </p>
            <p className="mt-1 text-2xl font-bold text-gray-900">
              {summary.byMode.get(mode) ?? 0}
            </p>
          </div>
        ))}
      </div>

      {/* Sync result */}
      {syncMessage && (
        <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900 flex items-start justify-between gap-3">
          <span className="whitespace-pre-line leading-relaxed">
            {syncMessage}
          </span>
          <button
            onClick={() => setSyncMessage(null)}
            className="text-green-700 hover:text-green-900"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {syncErrors.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <p className="font-semibold mb-1">
            {language === "th"
              ? `แถวที่ข้าม / มีปัญหา (${syncErrors.length})`
              : `Skipped / problem rows (${syncErrors.length})`}
          </p>
          <ul className="list-disc pl-5 space-y-0.5">
            {syncErrors.slice(0, 30).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {loadError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {language === "th"
            ? `อ่านตาราง service_price_master ไม่สำเร็จ: ${loadError}`
            : `Could not read service_price_master: ${loadError}`}
        </div>
      )}

      {/* Filters */}
      <div className="grid gap-2 sm:grid-cols-3 mb-4">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            language === "th"
              ? "ค้นหา code / ชื่อ / หมวด"
              : "Search code / name / category"
          }
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500 sm:col-span-2"
        />
        <select
          value={modeFilter}
          onChange={(e) => setModeFilter(e.target.value as QuoteMode | "all")}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="all">
            {language === "th" ? "ทุกโหมดราคา" : "All quote modes"}
          </option>
          {QUOTE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {QUOTE_MODE_LABELS[mode][language === "th" ? "th" : "en"]}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">
            {language === "th" ? "กำลังโหลด..." : "Loading..."}
          </div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {services.length === 0
              ? language === "th"
                ? "ยังไม่มีข้อมูลใน service_price_master — กดซิงค์จาก Google Sheet เพื่อเริ่มต้น"
                : "service_price_master is empty — run a sync to populate it"
              : language === "th"
              ? "ไม่พบรายการตามตัวกรอง"
              : "No matches for the active filters"}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="text-left p-3">Code</th>
                  <th className="text-left p-3">
                    {language === "th" ? "หมวด" : "Category"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "ชื่อบริการ" : "Service"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "โหมดราคา" : "Quote mode"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "ราคา" : "Price"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "งานด่วน" : "Urgent"}
                  </th>
                  <th className="text-left p-3">Scope</th>
                  <th className="text-left p-3">
                    {language === "th" ? "สถานะ" : "Status"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr
                    key={s.id}
                    className={`border-t border-gray-100 ${
                      s.active ? "" : "bg-gray-50/60"
                    }`}
                  >
                    <td className="p-3 font-mono text-xs text-gray-800">
                      {s.serviceCode}
                    </td>
                    <td className="p-3 text-gray-700">
                      {s.categoryTh}
                      {s.subcategoryTh && (
                        <span className="block text-[11px] text-gray-400">
                          {s.subcategoryTh}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-gray-900 font-medium">
                      {s.serviceNameTh}
                      {s.guideQuestions.length > 0 && (
                        <span className="block text-[11px] text-blue-600">
                          {language === "th"
                            ? `${s.guideQuestions.length} คำถามแนะนำ`
                            : `${s.guideQuestions.length} guide question(s)`}
                        </span>
                      )}
                    </td>
                    <td className="p-3">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          QUOTE_MODE_BADGE[s.quoteMode]
                        }`}
                      >
                        {s.quoteMode}
                      </span>
                    </td>
                    <td className="p-3 whitespace-nowrap font-semibold text-green-700">
                      {priceLabel(s)}
                    </td>
                    <td className="p-3 whitespace-nowrap text-gray-700">
                      {s.urgentAllowed ? (
                        <span className="text-yellow-800">
                          คิวงานด่วน +{s.urgentFeePerItem} บาท
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-3 text-xs text-gray-600">
                      <p>{s.branchScope}</p>
                      <p className="text-[11px] text-gray-400">{s.brand}</p>
                    </td>
                    <td className="p-3">
                      {s.active ? (
                        <span className="px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-800 text-[11px] font-semibold">
                          {language === "th" ? "ใช้งาน" : "Active"}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200 text-gray-600 text-[11px] font-semibold">
                          {language === "th" ? "ปิด" : "Inactive"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
