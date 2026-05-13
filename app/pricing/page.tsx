"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { RouteGuard } from "@/components/RouteGuard";
import { useLanguage } from "@/lib/languageContext";
import { formatCurrency } from "@/lib/utils";
import { branches as ALL_BRANCHES } from "@/lib/brandConfig";
import { SERVICE_CATEGORIES, type ServiceCategoryKey } from "@/lib/pricing";
import {
  closeServicePrice,
  fetchPricingCatalog,
  insertServicePrice,
  updateServicePrice,
  type ServicePriceInput,
  type ServicePriceRow,
} from "@/lib/pricingDb";

type PriceType = "fixed" | "estimate_required";

type FormState = {
  service_code: string;
  category: ServiceCategoryKey | "";
  service_name: string;
  description_template: string;
  base_price: string;
  price_type: PriceType;
  urgent_fee_default: string;
  active: boolean;
  branch_id: string;
  brand_id: string;
};

const EMPTY_FORM: FormState = {
  service_code: "",
  category: "",
  service_name: "",
  description_template: "",
  base_price: "",
  price_type: "fixed",
  urgent_fee_default: "0",
  active: true,
  branch_id: "",
  brand_id: "",
};

const BRAND_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "careu", label: "Care U" },
  { id: "ezy", label: "Ezy Repair" },
];

function rowToForm(row: ServicePriceRow): FormState {
  return {
    service_code: row.service_code,
    category: row.category as ServiceCategoryKey,
    service_name: row.service_name,
    description_template: row.description_template ?? "",
    base_price:
      row.base_price === null || row.base_price === undefined
        ? ""
        : String(row.base_price),
    price_type: row.price_type,
    urgent_fee_default:
      row.urgent_fee_default === null || row.urgent_fee_default === undefined
        ? "0"
        : String(row.urgent_fee_default),
    active: row.active,
    branch_id: row.branch_id ?? "",
    brand_id: row.brand_id ?? "",
  };
}

function formToInput(form: FormState): ServicePriceInput {
  return {
    service_code: form.service_code,
    category: form.category || "special",
    service_name: form.service_name,
    description_template: form.description_template || null,
    base_price:
      form.price_type === "estimate_required"
        ? null
        : form.base_price.trim() === ""
        ? null
        : Number(form.base_price),
    price_type: form.price_type,
    urgent_fee_default: Number(form.urgent_fee_default || 0),
    active: form.active,
    branch_id: form.branch_id || null,
    brand_id: form.brand_id || null,
  };
}

function isCurrentlyEffective(row: ServicePriceRow): boolean {
  if (!row.active) return false;
  if (row.effective_to) return new Date(row.effective_to) > new Date();
  return true;
}

export default function PricingPage() {
  return (
    <RouteGuard page="pricing">
      <PricingPageInner />
    </RouteGuard>
  );
}

function PricingPageInner() {
  const { language } = useLanguage();
  const [rows, setRows] = useState<ServicePriceRow[]>([]);
  const [fallbackOnly, setFallbackOnly] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<ServiceCategoryKey | "all">("all");
  const [showInactive, setShowInactive] = useState(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<ServicePriceRow | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saveMode, setSaveMode] = useState<"quick" | "version">("quick");
  const [isSyncing, setIsSyncing] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const res = await fetchPricingCatalog({});
    setRows(res.rows);
    setFallbackOnly(res.fallbackOnly);
    setError(res.error);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleRows = useMemo(() => {
    // Pick the most recent row per (service_code, branch_id, brand_id) tuple
    // so the table reads like a catalog and not a version log. The "history"
    // button (future) can surface older rows.
    const byKey = new Map<string, ServicePriceRow>();
    for (const row of rows) {
      const key = `${row.service_code}__${row.branch_id ?? ""}__${row.brand_id ?? ""}`;
      const existing = byKey.get(key);
      if (
        !existing ||
        new Date(row.effective_from) > new Date(existing.effective_from)
      ) {
        byKey.set(key, row);
      }
    }
    let list = Array.from(byKey.values());
    if (!showInactive) list = list.filter(isCurrentlyEffective);
    if (categoryFilter !== "all") {
      list = list.filter((r) => r.category === categoryFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          r.service_code.toLowerCase().includes(q) ||
          r.service_name.toLowerCase().includes(q)
      );
    }
    list.sort((a, b) =>
      a.category === b.category
        ? a.service_code.localeCompare(b.service_code)
        : a.category.localeCompare(b.category)
    );
    return list;
  }, [rows, showInactive, categoryFilter, search]);

  const summary = useMemo(() => {
    const activeRows = rows.filter(isCurrentlyEffective);
    const byCategory = new Map<string, number>();
    for (const r of activeRows) {
      byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
    }
    return {
      totalActive: activeRows.length,
      byCategory,
      fallbackCount: fallbackOnly.length,
    };
  }, [rows, fallbackOnly]);

  const handleOpenAdd = () => {
    setEditingRow(null);
    setForm(EMPTY_FORM);
    setSaveMode("quick");
    setIsModalOpen(true);
  };

  const handleOpenEdit = (row: ServicePriceRow) => {
    setEditingRow(row);
    setForm(rowToForm(row));
    setSaveMode("quick");
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingRow(null);
    setForm(EMPTY_FORM);
  };

  const validate = (f: FormState): string | null => {
    if (!f.service_code.trim()) return "service_code ห้ามว่าง";
    if (!f.category) return "เลือกหมวดบริการ";
    if (!f.service_name.trim()) return "service_name ห้ามว่าง";
    if (
      f.price_type === "fixed" &&
      (f.base_price.trim() === "" || Number.isNaN(Number(f.base_price)))
    ) {
      return "ราคาแบบ Fixed ต้องระบุตัวเลข";
    }
    return null;
  };

  const handleSubmit = async () => {
    const validationError = validate(form);
    if (validationError) {
      setStatusMessage(validationError);
      return;
    }
    setIsSubmitting(true);
    setStatusMessage(null);
    const input = formToInput(form);

    let opError: string | null = null;
    if (editingRow && saveMode === "quick") {
      const res = await updateServicePrice(editingRow.id, input);
      opError = res.error;
    } else if (editingRow && saveMode === "version") {
      const close = await closeServicePrice(editingRow.id);
      if (close.error) {
        opError = close.error;
      } else {
        const insert = await insertServicePrice(input);
        opError = insert.error;
      }
    } else {
      const insert = await insertServicePrice(input);
      opError = insert.error;
    }

    if (opError) {
      setStatusMessage(opError);
      setIsSubmitting(false);
      return;
    }

    setStatusMessage(
      saveMode === "version"
        ? language === "th"
          ? "บันทึกเวอร์ชันใหม่เรียบร้อย"
          : "Saved as new version"
        : editingRow
        ? language === "th"
          ? "บันทึกการแก้ไขเรียบร้อย"
          : "Updated"
        : language === "th"
        ? "เพิ่มรายการใหม่เรียบร้อย"
        : "Created"
    );
    setIsSubmitting(false);
    handleCloseModal();
    await load();
  };

  const handleDisable = async (row: ServicePriceRow) => {
    if (
      !window.confirm(
        language === "th"
          ? `ปิดใช้งาน "${row.service_name}" หรือไม่? รายการนี้จะไม่ถูกใช้คำนวณราคาในใบงานใหม่`
          : `Disable "${row.service_name}"? It will no longer apply to new orders.`
      )
    )
      return;
    const res = await closeServicePrice(row.id);
    if (res.error) {
      setStatusMessage(res.error);
      return;
    }
    setStatusMessage(
      language === "th" ? "ปิดใช้งานเรียบร้อย" : "Disabled"
    );
    await load();
  };

  const handleSyncToSheet = async () => {
    setIsSyncing(true);
    setStatusMessage(null);
    try {
      const res = await fetch("/api/sync-pricing-to-sheet", { method: "POST" });
      const json = (await res.json()) as {
        ok?: boolean;
        appended?: number;
        sheet?: string;
        reason?: string;
      };
      if (!res.ok || !json.ok) {
        setStatusMessage(
          language === "th"
            ? `ซิงค์ไป Sheet ไม่สำเร็จ: ${json.reason ?? `HTTP ${res.status}`}`
            : `Sync failed: ${json.reason ?? `HTTP ${res.status}`}`
        );
      } else {
        setStatusMessage(
          language === "th"
            ? `ซิงค์เรียบร้อย • เขียน ${json.appended ?? 0} แถวลงในแท็บ ${json.sheet ?? "Pricing"}`
            : `Synced • appended ${json.appended ?? 0} rows to ${json.sheet ?? "Pricing"}`
        );
      }
    } catch (err) {
      setStatusMessage(
        err instanceof Error ? err.message : "Network error"
      );
    }
    setIsSyncing(false);
  };

  const handleEnable = async (row: ServicePriceRow) => {
    const res = await updateServicePrice(row.id, {
      service_code: row.service_code,
      category: row.category,
      service_name: row.service_name,
      description_template: row.description_template ?? null,
      base_price:
        row.base_price === null || row.base_price === undefined
          ? null
          : Number(row.base_price),
      price_type: row.price_type,
      urgent_fee_default: Number(row.urgent_fee_default ?? 0),
      active: true,
      branch_id: row.branch_id,
      brand_id: row.brand_id,
    });
    if (res.error) {
      setStatusMessage(res.error);
      return;
    }
    setStatusMessage(language === "th" ? "เปิดใช้งานเรียบร้อย" : "Enabled");
    await load();
  };

  return (
    <div className="flex-1 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 border-l-4 border-yellow-400 pl-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS
          </p>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-900">
            {language === "th" ? "ตั้งราคา (Pricing Master)" : "Pricing Master"}
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            {language === "th"
              ? "จัดการบริการ ราคา และส่วนลด — เปลี่ยนแล้วใช้กับทุกใบงานใหม่ทันที"
              : "Edit services, prices, and rules — applies to every new order"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void handleSyncToSheet()}
            disabled={isSyncing}
            className="border border-green-600 text-green-700 hover:bg-green-50 px-4 py-2.5 rounded-lg transition font-medium disabled:opacity-50"
          >
            {isSyncing
              ? language === "th"
                ? "กำลังซิงค์..."
                : "Syncing..."
              : language === "th"
              ? "ซิงค์ไป Google Sheet"
              : "Sync to Google Sheet"}
          </button>
          <button
            onClick={handleOpenAdd}
            className="bg-green-700 hover:bg-green-800 text-white px-5 py-2.5 rounded-lg transition font-semibold"
          >
            + {language === "th" ? "เพิ่มบริการ" : "Add service"}
          </button>
        </div>
      </div>

      {/* Summary band */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">
            {language === "th" ? "รายการใช้งานอยู่" : "Active services"}
          </p>
          <p className="mt-1 text-2xl font-bold text-gray-900">
            {summary.totalActive}
          </p>
        </div>
        <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-4 shadow-sm">
          <p className="text-xs text-yellow-800">
            {language === "th"
              ? "ยังใช้ราคา hardcode (ยังไม่ย้ายเข้า DB)"
              : "Hardcoded fallback only"}
          </p>
          <p className="mt-1 text-2xl font-bold text-yellow-900">
            {summary.fallbackCount}
          </p>
        </div>
        <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm col-span-2">
          <p className="text-xs text-gray-500 mb-1">
            {language === "th" ? "จำนวนต่อหมวด" : "Per category"}
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            {SERVICE_CATEGORIES.map((c) => (
              <span
                key={c.code}
                className="px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-800"
              >
                {language === "th" ? c.labelTh : c.labelEn}:{" "}
                {summary.byCategory.get(c.code) ?? 0}
              </span>
            ))}
          </div>
        </div>
      </div>

      {statusMessage && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900 flex items-start justify-between gap-3">
          <span>{statusMessage}</span>
          <button
            onClick={() => setStatusMessage(null)}
            className="text-green-700 hover:text-green-900"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {language === "th"
            ? `อ่านตาราง service_prices ไม่สำเร็จ: ${error} — ขณะนี้แสดงเฉพาะราคา hardcode`
            : `service_prices read failed: ${error} — showing hardcoded fallback only`}
        </div>
      )}

      {/* Filters */}
      <div className="grid gap-2 sm:grid-cols-4 mb-4">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            language === "th" ? "ค้นหา service_code / ชื่อ" : "Search code / name"
          }
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500 sm:col-span-2"
        />
        <select
          value={categoryFilter}
          onChange={(e) =>
            setCategoryFilter(e.target.value as ServiceCategoryKey | "all")
          }
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="all">
            {language === "th" ? "ทุกหมวด" : "All categories"}
          </option>
          {SERVICE_CATEGORIES.map((c) => (
            <option key={c.code} value={c.code}>
              {language === "th" ? c.labelTh : c.labelEn}
            </option>
          ))}
        </select>
        <label className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm">
          <span className="text-gray-700">
            {language === "th" ? "รวมรายการที่ปิดใช้งาน" : "Include inactive"}
          </span>
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="w-4 h-4 accent-green-700"
          />
        </label>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">
            {language === "th" ? "กำลังโหลด..." : "Loading..."}
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {rows.length === 0
              ? language === "th"
                ? "ยังไม่มีข้อมูลในตาราง service_prices — กด + เพิ่มบริการ เพื่อเริ่มต้น (ตอนนี้ระบบยังใช้ราคา hardcode)"
                : "service_prices is empty — add the first service. Hardcoded fallback is in effect."
              : language === "th"
              ? "ไม่พบรายการตามตัวกรอง"
              : "No matches for the active filters"}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="text-left p-3">Code</th>
                  <th className="text-left p-3">
                    {language === "th" ? "หมวด" : "Category"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "ชื่อบริการ" : "Service name"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "ราคา" : "Price"}
                  </th>
                  <th className="text-left p-3">Urgent</th>
                  <th className="text-left p-3">
                    {language === "th" ? "ขอบเขต" : "Scope"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "สถานะ" : "Status"}
                  </th>
                  <th className="text-right p-3"></th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const currentlyEffective = isCurrentlyEffective(row);
                  const categoryLabel =
                    SERVICE_CATEGORIES.find((c) => c.code === row.category)
                      ?.labelTh ?? row.category;
                  const branchLabel = row.branch_id
                    ? ALL_BRANCHES.find((b) => b.id === row.branch_id)
                        ?.shortLabel ?? row.branch_id
                    : language === "th"
                    ? "ทุกสาขา"
                    : "All branches";
                  const brandLabel = row.brand_id
                    ? BRAND_OPTIONS.find((b) => b.id === row.brand_id)?.label ??
                      row.brand_id
                    : language === "th"
                    ? "ทุกแบรนด์"
                    : "All brands";
                  return (
                    <tr
                      key={row.id}
                      className={`border-t border-gray-100 ${
                        currentlyEffective ? "" : "bg-gray-50/60"
                      }`}
                    >
                      <td className="p-3 font-mono text-xs text-gray-800">
                        {row.service_code}
                      </td>
                      <td className="p-3 text-gray-700">{categoryLabel}</td>
                      <td className="p-3 text-gray-900 font-medium">
                        {row.service_name}
                        {row.description_template && (
                          <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-1">
                            {row.description_template}
                          </p>
                        )}
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        {row.price_type === "estimate_required" ? (
                          <span className="text-yellow-800 text-xs">
                            {language === "th" ? "ประเมินราคา" : "Estimate"}
                          </span>
                        ) : (
                          <span className="text-green-700 font-semibold">
                            {formatCurrency(Number(row.base_price ?? 0))}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-gray-700">
                        {row.urgent_fee_default
                          ? `+${formatCurrency(Number(row.urgent_fee_default))}`
                          : "—"}
                      </td>
                      <td className="p-3 text-xs text-gray-600">
                        <p>{branchLabel}</p>
                        <p className="text-[11px] text-gray-500">{brandLabel}</p>
                      </td>
                      <td className="p-3">
                        {currentlyEffective ? (
                          <span className="px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-800 text-[11px] font-semibold">
                            {language === "th" ? "ใช้งานอยู่" : "Active"}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200 text-gray-600 text-[11px] font-semibold">
                            {language === "th" ? "ปิดใช้งาน" : "Inactive"}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right whitespace-nowrap">
                        <button
                          onClick={() => handleOpenEdit(row)}
                          className="text-green-700 hover:text-green-800 text-sm font-medium mr-3"
                        >
                          {language === "th" ? "แก้ไข" : "Edit"}
                        </button>
                        {currentlyEffective ? (
                          <button
                            onClick={() => void handleDisable(row)}
                            className="text-red-600 hover:text-red-700 text-sm font-medium"
                          >
                            {language === "th" ? "ปิด" : "Disable"}
                          </button>
                        ) : (
                          <button
                            onClick={() => void handleEnable(row)}
                            className="text-gray-600 hover:text-gray-800 text-sm font-medium"
                          >
                            {language === "th" ? "เปิด" : "Enable"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Editor modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        title={
          editingRow
            ? language === "th"
              ? "แก้ไขบริการ"
              : "Edit service"
            : language === "th"
            ? "เพิ่มบริการใหม่"
            : "Add service"
        }
        onSubmit={isSubmitting ? undefined : handleSubmit}
        submitLabel={
          isSubmitting
            ? language === "th"
              ? "กำลังบันทึก..."
              : "Saving..."
            : editingRow && saveMode === "version"
            ? language === "th"
              ? "บันทึกเป็นเวอร์ชันใหม่"
              : "Save as new version"
            : language === "th"
            ? "บันทึก"
            : "Save"
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                service_code
              </label>
              <input
                type="text"
                value={form.service_code}
                onChange={(e) =>
                  setForm({ ...form, service_code: e.target.value })
                }
                disabled={!!editingRow}
                className="w-full rounded-lg border border-gray-300 p-2 text-sm font-mono outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-100"
                placeholder="ALT-001"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {language === "th" ? "หมวด" : "Category"}
              </label>
              <select
                value={form.category}
                onChange={(e) =>
                  setForm({
                    ...form,
                    category: e.target.value as ServiceCategoryKey | "",
                  })
                }
                className="w-full rounded-lg border border-gray-300 p-2 text-sm bg-white outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="">
                  {language === "th" ? "เลือกหมวด" : "Select category"}
                </option>
                {SERVICE_CATEGORIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {language === "th" ? c.labelTh : c.labelEn}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              {language === "th" ? "ชื่อบริการ" : "Service name"}
            </label>
            <input
              type="text"
              value={form.service_name}
              onChange={(e) =>
                setForm({ ...form, service_name: e.target.value })
              }
              className="w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
              placeholder="ตัดขากางเกง"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              description_template
            </label>
            <textarea
              value={form.description_template}
              onChange={(e) =>
                setForm({ ...form, description_template: e.target.value })
              }
              rows={2}
              className="w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
              placeholder={
                language === "th"
                  ? "ข้อความตั้งต้นที่จะใส่ใน field รายละเอียดงานของใบงาน"
                  : "Default detail text inserted into new order forms"
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                price_type
              </label>
              <select
                value={form.price_type}
                onChange={(e) =>
                  setForm({
                    ...form,
                    price_type: e.target.value as PriceType,
                  })
                }
                className="w-full rounded-lg border border-gray-300 p-2 text-sm bg-white outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="fixed">
                  fixed{language === "th" ? " (ราคาคงที่)" : ""}
                </option>
                <option value="estimate_required">
                  estimate_required
                  {language === "th" ? " (ประเมินราคา)" : ""}
                </option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                base_price (฿)
              </label>
              <input
                type="number"
                inputMode="decimal"
                value={form.base_price}
                onChange={(e) =>
                  setForm({ ...form, base_price: e.target.value })
                }
                disabled={form.price_type === "estimate_required"}
                className="w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-100"
                placeholder="0"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                urgent_fee_default (฿)
              </label>
              <input
                type="number"
                inputMode="decimal"
                value={form.urgent_fee_default}
                onChange={(e) =>
                  setForm({ ...form, urgent_fee_default: e.target.value })
                }
                className="w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                branch_id
              </label>
              <select
                value={form.branch_id}
                onChange={(e) =>
                  setForm({ ...form, branch_id: e.target.value })
                }
                className="w-full rounded-lg border border-gray-300 p-2 text-sm bg-white outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="">
                  {language === "th" ? "ทุกสาขา" : "All branches"}
                </option>
                {ALL_BRANCHES.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.shortLabel}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                brand_id
              </label>
              <select
                value={form.brand_id}
                onChange={(e) =>
                  setForm({ ...form, brand_id: e.target.value })
                }
                className="w-full rounded-lg border border-gray-300 p-2 text-sm bg-white outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="">
                  {language === "th" ? "ทุกแบรนด์" : "All brands"}
                </option>
                {BRAND_OPTIONS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="flex items-center gap-2 mt-5">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) =>
                    setForm({ ...form, active: e.target.checked })
                  }
                  className="w-4 h-4 accent-green-700"
                />
                <span className="text-sm text-gray-700">
                  {language === "th" ? "ใช้งานอยู่" : "Active"}
                </span>
              </label>
            </div>
          </div>

          {editingRow && (
            <div className="border-t border-gray-200 pt-3 mt-3">
              <p className="text-xs font-semibold text-gray-700 mb-2">
                {language === "th" ? "โหมดบันทึก" : "Save mode"}
              </p>
              <div className="flex flex-col gap-1.5 text-sm">
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="saveMode"
                    checked={saveMode === "quick"}
                    onChange={() => setSaveMode("quick")}
                    className="mt-0.5 accent-green-700"
                  />
                  <span>
                    <span className="font-medium">
                      {language === "th" ? "แก้ไขในที่เดิม" : "Quick edit"}
                    </span>
                    <span className="block text-[11px] text-gray-500">
                      {language === "th"
                        ? "ใช้สำหรับแก้คำผิด — ไม่บันทึกประวัติเวอร์ชัน"
                        : "Use for typo fixes — does not bump version history"}
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="saveMode"
                    checked={saveMode === "version"}
                    onChange={() => setSaveMode("version")}
                    className="mt-0.5 accent-green-700"
                  />
                  <span>
                    <span className="font-medium">
                      {language === "th"
                        ? "บันทึกเป็นเวอร์ชันใหม่"
                        : "Save as new version"}
                    </span>
                    <span className="block text-[11px] text-gray-500">
                      {language === "th"
                        ? "ปิดเวอร์ชันเก่า (เซ็ต effective_to = วันนี้) แล้วสร้างเวอร์ชันใหม่ — ใช้เมื่อเปลี่ยนราคา"
                        : "Closes the old row and inserts a new one — use for real price changes"}
                    </span>
                  </span>
                </label>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
