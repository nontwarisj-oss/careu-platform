"use client";

import { useEffect, useMemo, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import {
  type AnalyticsOrder,
  isLastMonth,
  isThisMonth,
  isThisYear,
  isToday,
  sumRevenue,
} from "@/lib/analytics";
import {
  computeProfitByBranch,
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
import { SimpleLineChart } from "@/components/charts/SimpleLineChart";
import { buildExportFilename, downloadCsv } from "@/lib/csvExport";

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

export default function ProfitReportPage() {
  const [orders, setOrders] = useState<AnalyticsOrder[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filters, setFilters] = useState<ReportFilterState>({
    range: "month",
    branchId: "all",
  });

  useEffect(() => {
    void (async () => {
      const [ordRes, expRes] = await Promise.all([
        supabase
          .from("orders")
          .select(
            "id, customer_id, price, status, created_at, branch_id, subtotal, discount, urgent_fee, service_category, service_code, service_name, promotion_code, customer_type, payment_status"
          )
          .order("created_at", { ascending: false }),
        supabase
          .from("expenses")
          .select(
            "id, expense_date, category, description, amount, branch_id, payment_method, notes, created_by, created_at"
          ),
      ]);
      if (!ordRes.error) {
        setOrders(
          ((ordRes.data ?? []) as unknown as Array<Record<string, unknown>>).map(
            (row) => ({
              id: String(row.id),
              customer_id: (row.customer_id as string) ?? null,
              price: Number(row.price ?? 0),
              status: (row.status as string) ?? "",
              created_at: row.created_at as string,
              branch_id: (row.branch_id as string) ?? null,
              subtotal:
                row.subtotal !== null && row.subtotal !== undefined
                  ? Number(row.subtotal)
                  : null,
              discount: Number(row.discount ?? 0),
              urgent_fee: Number(row.urgent_fee ?? 0),
              service_category: (row.service_category as string) ?? null,
              service_code: (row.service_code as string) ?? null,
              service_name: (row.service_name as string) ?? null,
              promotion_code: (row.promotion_code as string) ?? null,
              customer_type: (row.customer_type as string) ?? null,
              payment_status: (row.payment_status as string) ?? "unpaid",
            })
          )
        );
      }
      if (!expRes.error) {
        setExpenses(
          ((expRes.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
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

  const scopedOrders = useMemo(() => {
    if (filters.branchId === "all") return orders;
    return orders.filter((o) => o.branch_id === filters.branchId);
  }, [orders, filters.branchId]);

  const scopedExpenses = useMemo(() => {
    if (filters.branchId === "all") return expenses;
    return expenses.filter((e) => e.branch_id === filters.branchId);
  }, [expenses, filters.branchId]);

  const window = useMemo(() => {
    const window = filters.range;
    const pred = (iso: string) => {
      if (window === "today") return isToday(iso);
      if (window === "month") return isThisMonth(iso);
      if (window === "year") return isThisYear(iso);
      return true;
    };
    const expPred = (iso: string) => {
      const normalized = iso.includes("T") ? iso : `${iso}T00:00:00`;
      return pred(normalized);
    };
    const o = scopedOrders.filter((o) => pred(o.created_at));
    const e = scopedExpenses.filter((e) => expPred(e.expense_date));
    const revenue = sumRevenue(o);
    const expense = sumExpenses(e);
    const net = revenue - expense;
    const margin = revenue > 0 ? Math.round((net / revenue) * 100) : 0;
    return { revenue, expense, net, margin };
  }, [scopedOrders, scopedExpenses, filters.range]);

  const todayProfit =
    sumRevenue(scopedOrders.filter((o) => isToday(o.created_at))) -
    sumExpenses(filterTodayExpenses(scopedExpenses));
  const monthProfit =
    sumRevenue(scopedOrders.filter((o) => isThisMonth(o.created_at))) -
    sumExpenses(filterThisMonthExpenses(scopedExpenses));
  const lastMonthProfit =
    sumRevenue(scopedOrders.filter((o) => isLastMonth(o.created_at))) -
    sumExpenses(filterLastMonthExpenses(scopedExpenses));
  const yearProfit =
    sumRevenue(scopedOrders.filter((o) => isThisYear(o.created_at))) -
    sumExpenses(filterThisYearExpenses(scopedExpenses));

  const branchProfit = computeProfitByBranch(orders, expenses);

  const trendMonths = lastNMonthKeys(6);
  const trend = trendMonths.map((m) => {
    const rev = sumRevenue(
      scopedOrders.filter((o) => {
        const d = new Date(o.created_at);
        return d.getFullYear() === m.year && d.getMonth() === m.month;
      })
    );
    const exp = sumExpenses(
      scopedExpenses.filter((e) => {
        const d = new Date(
          e.expense_date.includes("T") ? e.expense_date : `${e.expense_date}T00:00`
        );
        return d.getFullYear() === m.year && d.getMonth() === m.month;
      })
    );
    return { label: m.label, value: rev - exp };
  });

  const handleExport = () => {
    const headers = ["สาขา", "รายได้", "ค่าใช้จ่าย", "กำไรสุทธิ", "อัตรากำไร %"];
    const rows = branchProfit.map((b) => ({
      สาขา: b.shortLabel,
      รายได้: b.revenue,
      ค่าใช้จ่าย: b.expense,
      กำไรสุทธิ: b.netProfit,
      "อัตรากำไร %": b.marginPercent,
    }));
    rows.push({
      สาขา: "รวมในช่วงที่เลือก",
      รายได้: window.revenue,
      ค่าใช้จ่าย: window.expense,
      กำไรสุทธิ: window.net,
      "อัตรากำไร %": window.margin,
    });
    downloadCsv(buildExportFilename("profit"), headers, rows);
  };

  return (
    <ReportFrame
      title="รายงานกำไร"
      description="กำไรสุทธิ อัตรากำไร และกำไรตามสาขา"
      toolbar={<ReportFilters value={filters} onChange={setFilters} />}
      onExportCsv={handleExport}
      exportDisabled={isLoading}
    >
      {isLoading ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          กำลังโหลด...
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label="กำไรในช่วงที่เลือก" value={formatCurrency(window.net)} tone={window.net >= 0 ? "green" : "red"} />
            <Kpi label="อัตรากำไร" value={`${window.margin}%`} tone={window.net >= 0 ? "yellow" : "red"} />
            <Kpi label="รายได้" value={formatCurrency(window.revenue)} tone="white" />
            <Kpi label="ค่าใช้จ่าย" value={formatCurrency(window.expense)} tone="white" />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label="กำไรวันนี้" value={formatCurrency(todayProfit)} tone={todayProfit >= 0 ? "green" : "red"} />
            <Kpi label="กำไรเดือนนี้" value={formatCurrency(monthProfit)} tone={monthProfit >= 0 ? "green" : "red"} />
            <Kpi label="เดือนที่แล้ว" value={formatCurrency(lastMonthProfit)} tone="white" />
            <Kpi label="กำไรปีนี้" value={formatCurrency(yearProfit)} tone="white" />
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h3 className="text-lg font-bold text-gray-900 mb-3">แนวโน้มกำไร 6 เดือน</h3>
            <SimpleLineChart data={trend} />
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h3 className="text-lg font-bold text-gray-900 mb-3">กำไรตามสาขา</h3>
            <ul className="space-y-2 text-sm">
              {branchProfit.map((b) => (
                <li
                  key={b.branchId}
                  className="flex items-center justify-between rounded-xl border border-gray-200 px-3 py-2"
                >
                  <div>
                    <p className="font-medium text-gray-800">{b.shortLabel}</p>
                    <p className="text-xs text-gray-500">
                      รายได้ {formatCurrency(b.revenue)} • ค่าใช้จ่าย{" "}
                      {formatCurrency(b.expense)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={`font-semibold ${
                        b.netProfit >= 0 ? "text-green-700" : "text-red-700"
                      }`}
                    >
                      {formatCurrency(b.netProfit)}
                    </p>
                    <p className="text-[11px] text-gray-500">margin {b.marginPercent}%</p>
                  </div>
                </li>
              ))}
            </ul>
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
  tone: "green" | "yellow" | "white" | "red";
}) {
  const toneClass = {
    green: "border-green-100 bg-green-50 text-green-900",
    yellow: "border-yellow-100 bg-yellow-50 text-yellow-900",
    white: "border-gray-100 bg-white text-gray-900",
    red: "border-red-100 bg-red-50 text-red-900",
  }[tone];
  return (
    <div className={`rounded-2xl border ${toneClass} p-4 shadow-sm`}>
      <p className="text-xs opacity-75">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
