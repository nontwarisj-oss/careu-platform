"use client";

import { useEffect, useMemo, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import {
  aggregateExpensesByBranch,
  aggregateExpensesByCategory,
  filterLastMonthExpenses,
  filterThisMonthExpenses,
  filterThisYearExpenses,
  filterTodayExpenses,
  sumExpenses,
  type ExpenseRow,
} from "@/lib/expenses";
import { ReportFrame } from "@/components/reports/ReportFrame";
import {
  ReportFilters,
  type ReportFilterState,
} from "@/components/reports/ReportFilters";
import { SimpleBarChart } from "@/components/charts/SimpleBarChart";
import { SimpleLineChart } from "@/components/charts/SimpleLineChart";
import { buildExportFilename, downloadCsv } from "@/lib/csvExport";
import { getBranchById } from "@/lib/brandConfig";
import { getCategoryLabel, getPaymentMethodLabel } from "@/lib/expenses";

const TH_MONTHS = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
];

function lastNMonthKeys(n: number) {
  const now = new Date();
  const out: Array<{ year: number; month: number; label: string }> = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      year: d.getFullYear(),
      month: d.getMonth(),
      label: TH_MONTHS[d.getMonth()],
    });
  }
  return out;
}

export default function ExpensesReportPage() {
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [filters, setFilters] = useState<ReportFilterState>({
    range: "month",
    branchId: "all",
  });

  useEffect(() => {
    void (async () => {
      const res = await supabase
        .from("expenses")
        .select(
          "id, expense_date, category, description, amount, branch_id, payment_method, notes, created_by, created_at"
        )
        .order("expense_date", { ascending: false });
      if (res.error) {
        setErrorMessage(
          /relation .* does not exist|schema cache/i.test(res.error.message)
            ? "ยังไม่ได้รัน migration 20260518_expense_log.sql ใน Supabase"
            : res.error.message
        );
      } else {
        setExpenses(
          ((res.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
            id: String(row.id),
            expense_date: (row.expense_date as string) ?? new Date().toISOString(),
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
      }
      setIsLoading(false);
    })();
  }, []);

  const scoped = useMemo(() => {
    if (filters.branchId === "all") return expenses;
    return expenses.filter((e) => e.branch_id === filters.branchId);
  }, [expenses, filters.branchId]);

  const today = sumExpenses(filterTodayExpenses(scoped));
  const month = sumExpenses(filterThisMonthExpenses(scoped));
  const lastMonth = sumExpenses(filterLastMonthExpenses(scoped));
  const year = sumExpenses(filterThisYearExpenses(scoped));
  const total = sumExpenses(scoped);

  const byCategory = aggregateExpensesByCategory(scoped).filter((c) => c.total > 0);
  const byBranch = aggregateExpensesByBranch(expenses);

  const trendMonths = lastNMonthKeys(6);
  const trend = trendMonths.map((m) => ({
    label: m.label,
    value: sumExpenses(
      scoped.filter((e) => {
        const d = new Date(
          e.expense_date.includes("T") ? e.expense_date : `${e.expense_date}T00:00`
        );
        return d.getFullYear() === m.year && d.getMonth() === m.month;
      })
    ),
  }));

  const handleExport = () => {
    const headers = [
      "วันที่",
      "หมวด",
      "รายละเอียด",
      "สาขา",
      "วิธีชำระ",
      "บันทึก",
      "จำนวน",
    ];
    const rows = scoped.map((e) => ({
      วันที่: new Date(e.expense_date).toLocaleDateString("th-TH"),
      หมวด: getCategoryLabel(e.category),
      รายละเอียด: e.description ?? "",
      สาขา: e.branch_id ? getBranchById(e.branch_id).shortLabel : "-",
      วิธีชำระ: getPaymentMethodLabel(e.payment_method),
      บันทึก: e.notes ?? "",
      จำนวน: e.amount,
    }));
    downloadCsv(buildExportFilename("expenses"), headers, rows);
  };

  return (
    <ReportFrame
      title="รายงานค่าใช้จ่าย"
      description="ค่าใช้จ่ายตามหมวด สาขา และเดือน"
      toolbar={<ReportFilters value={filters} onChange={setFilters} />}
      onExportCsv={handleExport}
      exportDisabled={isLoading || scoped.length === 0}
    >
      {errorMessage && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {isLoading ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          กำลังโหลด...
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Kpi label="วันนี้" value={formatCurrency(today)} tone="yellow" />
            <Kpi label="เดือนนี้" value={formatCurrency(month)} tone="yellow" />
            <Kpi label="เดือนที่แล้ว" value={formatCurrency(lastMonth)} tone="white" />
            <Kpi label="ปีนี้" value={formatCurrency(year)} tone="white" />
            <Kpi label="ทั้งหมด" value={formatCurrency(total)} tone="purple" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h3 className="text-lg font-bold text-gray-900 mb-3">
                แนวโน้มค่าใช้จ่าย 6 เดือน
              </h3>
              <SimpleLineChart data={trend} />
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h3 className="text-lg font-bold text-gray-900 mb-3">ค่าใช้จ่ายตามสาขา</h3>
              <SimpleBarChart
                data={byBranch.map((b) => ({ label: b.shortLabel, value: b.total }))}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h3 className="text-lg font-bold text-gray-900 mb-3">หมวดค่าใช้จ่ายสูงสุด</h3>
            {byCategory.length === 0 ? (
              <p className="text-sm text-gray-500">ยังไม่มีรายการ — เพิ่มได้ที่หน้า /expenses</p>
            ) : (
              <SimpleBarChart
                data={byCategory.map((c) => ({ label: c.labelTh, value: c.total }))}
              />
            )}
          </div>
        </>
      )}
    </ReportFrame>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "yellow" | "white" | "purple";
}) {
  const toneClass = {
    yellow: "border-yellow-100 bg-yellow-50 text-yellow-900",
    white: "border-gray-100 bg-white text-gray-900",
    purple: "border-purple-100 bg-purple-50 text-purple-900",
  }[tone];
  return (
    <div className={`rounded-2xl border ${toneClass} p-4 shadow-sm`}>
      <p className="text-xs opacity-75">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
