"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useBranch } from "@/lib/branchContext";
import { branches, getBranchById } from "@/lib/brandConfig";
import { BrandLogo } from "@/components/BrandLogo";
import { RouteGuard } from "@/components/RouteGuard";
import {
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  aggregateExpensesByCategory,
  filterThisMonthExpenses,
  filterTodayExpenses,
  filterThisYearExpenses,
  getCategoryLabel,
  getPaymentMethodLabel,
  sumExpenses,
  type ExpenseCategoryKey,
  type ExpenseRow,
  type PaymentMethodKey,
} from "@/lib/expenses";

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function ExpensesPage() {
  return (
    <RouteGuard page="expenses">
      <ExpensesPageInner />
    </RouteGuard>
  );
}

function ExpensesPageInner() {
  const { branch } = useBranch();

  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // Form state
  const [expenseDate, setExpenseDate] = useState<string>(todayIso());
  const [category, setCategory] = useState<ExpenseCategoryKey>("materials");
  const [description, setDescription] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodKey>("cash");
  const [formBranchId, setFormBranchId] = useState<string>(branch.id);
  const [notes, setNotes] = useState<string>("");

  // Filters for the list
  const [filterBranchId, setFilterBranchId] = useState<string | "all">("all");
  const [filterCategory, setFilterCategory] = useState<string | "all">("all");

  // Sync the form's default branch with the selected branch from the sidebar.
  useEffect(() => {
    if (!editingId) setFormBranchId(branch.id);
  }, [branch.id, editingId]);

  const fetchExpenses = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    const { data, error } = await supabase
      .from("expenses")
      .select(
        "id, expense_date, category, description, amount, branch_id, payment_method, notes, created_by, created_at"
      )
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) {
      if (/relation .* does not exist|table .* does not exist|schema cache/i.test(error.message)) {
        setErrorMessage(
          "ยังไม่ได้รัน migration 20260518_expense_log.sql — โปรดเปิด Supabase SQL editor แล้วรันก่อนใช้งาน"
        );
      } else {
        setErrorMessage(error.message);
      }
      setExpenses([]);
      setIsLoading(false);
      return;
    }

    setExpenses(
      ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        expense_date: (row.expense_date as string) ?? todayIso(),
        category: (row.category as string) ?? "other",
        description: (row.description as string) ?? null,
        amount: Number(row.amount ?? 0),
        branch_id: (row.branch_id as string) ?? null,
        payment_method: (row.payment_method as string) ?? null,
        notes: (row.notes as string) ?? null,
        created_by: (row.created_by as string) ?? null,
        created_at: (row.created_at as string) ?? new Date().toISOString(),
      }))
    );
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void fetchExpenses();
  }, [fetchExpenses]);

  const resetForm = () => {
    setEditingId(null);
    setExpenseDate(todayIso());
    setCategory("materials");
    setDescription("");
    setAmount("");
    setPaymentMethod("cash");
    setFormBranchId(branch.id);
    setNotes("");
  };

  const handleSubmit = async () => {
    setToast(null);
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setToast("จำนวนเงินต้องเป็นตัวเลขมากกว่า 0");
      return;
    }
    if (!description.trim() && !notes.trim()) {
      setToast("กรอกรายละเอียดหรือบันทึกเพื่อให้ตามตรวจสอบได้");
      return;
    }
    setIsSubmitting(true);
    const payload = {
      expense_date: expenseDate,
      category,
      description: description.trim() || null,
      amount: numericAmount,
      branch_id: formBranchId,
      payment_method: paymentMethod,
      notes: notes.trim() || null,
    };

    const res = editingId
      ? await supabase.from("expenses").update(payload).eq("id", editingId)
      : await supabase.from("expenses").insert(payload);

    if (res.error) {
      setToast(res.error.message);
      setIsSubmitting(false);
      return;
    }

    setToast(editingId ? "อัปเดตรายการแล้ว" : "บันทึกรายการแล้ว");
    setTimeout(() => setToast(null), 2500);
    resetForm();
    setIsSubmitting(false);
    await fetchExpenses();
  };

  const handleEdit = (row: ExpenseRow) => {
    setEditingId(row.id);
    setExpenseDate(row.expense_date);
    setCategory((row.category as ExpenseCategoryKey) ?? "other");
    setDescription(row.description ?? "");
    setAmount(String(row.amount));
    setPaymentMethod((row.payment_method as PaymentMethodKey) ?? "cash");
    setFormBranchId(row.branch_id ?? branch.id);
    setNotes(row.notes ?? "");
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const handleSyncFromSheet = async () => {
    setIsSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch("/api/sync-expenses", { method: "POST" });
      const json = (await res.json()) as {
        ok?: boolean;
        inserted?: number;
        matchedExisting?: number;
        skipped?: number;
        totalRows?: number;
        error?: string;
      };
      if (!res.ok || json.error) {
        setSyncMessage(json.error ?? `Sync failed (HTTP ${res.status})`);
      } else {
        const added = json.inserted ?? 0;
        const matched = json.matchedExisting ?? 0;
        const skip = json.skipped ?? 0;
        setSyncMessage(
          `ซิงค์ค่าใช้จ่ายเสร็จแล้ว\nเพิ่มใหม่ ${added} รายการ\nมีอยู่แล้ว ${matched} รายการ${
            skip > 0 ? `\nข้าม ${skip} รายการ (ขาดข้อมูล)` : ""
          }`
        );
        await fetchExpenses();
      }
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : "Sync failed");
    }
    setIsSyncing(false);
  };

  const handleDelete = async (row: ExpenseRow) => {
    if (typeof window !== "undefined" && !window.confirm("ลบรายการนี้?")) return;
    const { error } = await supabase.from("expenses").delete().eq("id", row.id);
    if (error) {
      setToast(error.message);
      return;
    }
    setToast("ลบรายการแล้ว");
    setTimeout(() => setToast(null), 2500);
    await fetchExpenses();
  };

  // ---- Derived ---------------------------------------------------------
  const filtered = useMemo(() => {
    return expenses.filter((e) => {
      if (filterBranchId !== "all" && e.branch_id !== filterBranchId) return false;
      if (filterCategory !== "all" && e.category !== filterCategory) return false;
      return true;
    });
  }, [expenses, filterBranchId, filterCategory]);

  const summary = useMemo(() => {
    return {
      today: sumExpenses(filterTodayExpenses(filtered)),
      month: sumExpenses(filterThisMonthExpenses(filtered)),
      year: sumExpenses(filterThisYearExpenses(filtered)),
      total: sumExpenses(filtered),
    };
  }, [filtered]);

  const byCategory = useMemo(() => aggregateExpensesByCategory(filtered), [filtered]);

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-6 flex flex-col md:flex-row md:items-end md:justify-between gap-4 border-l-4 border-yellow-400 pl-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS • Expense Log
          </p>
          <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
            ค่าใช้จ่าย
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            บันทึก/แก้ไขค่าใช้จ่ายของแต่ละสาขา ระบบจะนำไปคำนวณกำไรอัตโนมัติ
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleSyncFromSheet()}
            disabled={isSyncing}
            className="bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg text-sm"
          >
            {isSyncing ? "กำลังซิงค์..." : "ซิงค์จาก Google Sheet"}
          </button>
          <div className="flex items-center gap-3 bg-white rounded-2xl border border-green-100 shadow-sm px-4 py-2">
            <BrandLogo size="sm" variant="onLight" />
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-gray-500">
                สาขาที่เลือก
              </p>
              <p className="text-sm font-semibold text-gray-800 truncate max-w-[200px]">
                {branch.shortLabel}
              </p>
              <p className="text-[10px] text-gray-500 truncate max-w-[200px]">
                {branch.address}
              </p>
            </div>
          </div>
        </div>
      </div>

      {syncMessage && (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900 flex items-start justify-between gap-3">
          <span className="whitespace-pre-line leading-relaxed">{syncMessage}</span>
          <button
            type="button"
            onClick={() => setSyncMessage(null)}
            className="text-green-700 hover:text-green-900 -mt-0.5"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {errorMessage && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {toast && (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {toast}
        </div>
      )}

      {/* Summary band */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Stat label="ค่าใช้จ่ายวันนี้" value={formatCurrency(summary.today)} tone="yellow" />
        <Stat label="เดือนนี้" value={formatCurrency(summary.month)} tone="white" />
        <Stat label="ปีนี้" value={formatCurrency(summary.year)} tone="green" />
        <Stat label="รวมตามตัวกรอง" value={formatCurrency(summary.total)} tone="purple" />
      </div>

      {/* Quick add form */}
      <div className="bg-white p-5 md:p-6 rounded-2xl border border-green-100 shadow-sm mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">
            {editingId ? "แก้ไขรายการค่าใช้จ่าย" : "เพิ่มค่าใช้จ่าย"}
          </h2>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ยกเลิกการแก้ไข
            </button>
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 mb-1">วันที่</span>
            <input
              type="date"
              value={expenseDate}
              onChange={(e) => setExpenseDate(e.target.value)}
              className="w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 mb-1">หมวดค่าใช้จ่าย</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ExpenseCategoryKey)}
              className="w-full rounded-xl border border-gray-300 bg-white p-3 outline-none focus:ring-2 focus:ring-green-500"
            >
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.labelTh}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 mb-1">จำนวนเงิน (บาท)</span>
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
            />
          </label>
          <label className="block md:col-span-2">
            <span className="block text-xs font-medium text-gray-700 mb-1">รายละเอียด</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="เช่น ค่าซื้อด้าย, ค่าน้ำเดือนพฤษภาคม"
              className="w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 mb-1">วิธีชำระ</span>
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value as PaymentMethodKey)}
              className="w-full rounded-xl border border-gray-300 bg-white p-3 outline-none focus:ring-2 focus:ring-green-500"
            >
              {PAYMENT_METHODS.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.labelTh}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 mb-1">สาขา</span>
            <select
              value={formBranchId}
              onChange={(e) => setFormBranchId(e.target.value)}
              className="w-full rounded-xl border border-gray-300 bg-white p-3 outline-none focus:ring-2 focus:ring-green-500"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.shortLabel}
                </option>
              ))}
            </select>
          </label>
          <label className="block md:col-span-2 lg:col-span-3">
            <span className="block text-xs font-medium text-gray-700 mb-1">บันทึกเพิ่มเติม</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="ระบุเลขใบเสร็จหรือหมายเหตุเพิ่มเติม"
              className="w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
            />
          </label>
        </div>
        <button
          onClick={() => void handleSubmit()}
          disabled={isSubmitting}
          className="mt-4 w-full md:w-auto bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white font-semibold py-3 px-6 rounded-xl"
        >
          {isSubmitting
            ? "กำลังบันทึก..."
            : editingId
            ? "บันทึกการแก้ไข"
            : "บันทึกค่าใช้จ่าย"}
        </button>
      </div>

      {/* By category */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-6">
        <div className="lg:col-span-2 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-3">ค่าใช้จ่ายแยกตามหมวด</h3>
          {byCategory.filter((c) => c.total > 0).length === 0 ? (
            <p className="text-sm text-gray-500">ยังไม่มีรายการ</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {byCategory
                .filter((c) => c.total > 0)
                .map((c) => (
                  <li key={c.code} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-gray-700">
                        {c.labelTh} <span className="text-xs text-gray-500">({c.count})</span>
                      </span>
                      <span className="font-semibold text-gray-800">
                        {formatCurrency(c.total)}
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-green-500 to-yellow-400"
                        style={{
                          width: `${
                            byCategory[0]?.total
                              ? Math.min(
                                  100,
                                  Math.round((c.total / byCategory[0].total) * 100)
                                )
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-yellow-200 bg-yellow-50/40 p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-3">ตัวกรองรายการ</h3>
          <div className="space-y-3 text-sm">
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">สาขา</span>
              <select
                value={filterBranchId}
                onChange={(e) => setFilterBranchId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white p-2 outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="all">ทุกสาขา</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.shortLabel}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">หมวดค่าใช้จ่าย</span>
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white p-2 outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="all">ทุกหมวด</option>
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.labelTh}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-100 p-4">
          <div>
            <h3 className="text-lg font-bold text-gray-900">รายการค่าใช้จ่าย</h3>
            <p className="text-xs text-gray-500">
              แสดง {filtered.length} จาก {expenses.length} รายการ
            </p>
          </div>
        </div>
        {isLoading ? (
          <p className="p-8 text-center text-gray-500">กำลังโหลด...</p>
        ) : filtered.length === 0 ? (
          <p className="p-8 text-center text-gray-500">ยังไม่มีรายการ</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="text-left p-3">วันที่</th>
                  <th className="text-left p-3">หมวด</th>
                  <th className="text-left p-3">รายละเอียด</th>
                  <th className="text-left p-3">สาขา</th>
                  <th className="text-left p-3">วิธีชำระ</th>
                  <th className="text-right p-3">จำนวน</th>
                  <th className="text-left p-3 print:hidden">การกระทำ</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.id} className="border-t border-gray-100">
                    <td className="p-3 text-sm text-gray-700 whitespace-nowrap">
                      {new Date(row.expense_date).toLocaleDateString("th-TH")}
                    </td>
                    <td className="p-3 text-sm text-gray-700">
                      {getCategoryLabel(row.category)}
                    </td>
                    <td className="p-3 text-sm text-gray-800">
                      <div className="font-medium">{row.description ?? "-"}</div>
                      {row.notes && (
                        <div className="text-xs text-gray-500 mt-0.5">{row.notes}</div>
                      )}
                    </td>
                    <td className="p-3 text-sm text-gray-700">
                      {row.branch_id ? getBranchById(row.branch_id).shortLabel : "-"}
                    </td>
                    <td className="p-3 text-sm text-gray-700">
                      {getPaymentMethodLabel(row.payment_method)}
                    </td>
                    <td className="p-3 text-sm text-right font-semibold text-gray-800">
                      {formatCurrency(row.amount)}
                    </td>
                    <td className="p-3 text-sm print:hidden">
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() => handleEdit(row)}
                          className="text-blue-600 hover:text-blue-800 font-medium"
                        >
                          แก้ไข
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(row)}
                          className="text-red-600 hover:text-red-800 font-medium"
                        >
                          ลบ
                        </button>
                      </div>
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

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "yellow" | "purple" | "white";
}) {
  const toneClass = {
    green: "border-green-100 bg-green-50 text-green-900",
    yellow: "border-yellow-100 bg-yellow-50 text-yellow-900",
    purple: "border-purple-100 bg-purple-50 text-purple-900",
    white: "border-gray-100 bg-white text-gray-900",
  }[tone];
  return (
    <div className={`rounded-2xl border ${toneClass} p-4 shadow-sm`}>
      <p className="text-xs opacity-75">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
