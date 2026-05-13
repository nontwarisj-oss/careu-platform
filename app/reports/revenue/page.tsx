"use client";

import { useEffect, useMemo, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import {
  type AnalyticsOrder,
  aggregateByBranch,
  aggregateTopServices,
  growthPercent,
  isLastMonth,
  isThisMonth,
  isThisWeek,
  isThisYear,
  isToday,
  sumRevenue,
} from "@/lib/analytics";
import { ReportFrame } from "@/components/reports/ReportFrame";
import {
  ReportFilters,
  type ReportFilterState,
} from "@/components/reports/ReportFilters";
import { SimpleBarChart } from "@/components/charts/SimpleBarChart";
import { SimpleLineChart } from "@/components/charts/SimpleLineChart";

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

export default function RevenueReportPage() {
  const [orders, setOrders] = useState<AnalyticsOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filters, setFilters] = useState<ReportFilterState>({
    range: "month",
    branchId: "all",
  });

  useEffect(() => {
    void (async () => {
      const res = await supabase
        .from("orders")
        .select(
          "id, customer_id, price, status, created_at, branch_id, subtotal, discount, urgent_fee, service_category, service_code, service_name, promotion_code, customer_type, payment_status"
        )
        .order("created_at", { ascending: false });
      if (!res.error) {
        setOrders(
          ((res.data ?? []) as unknown as Array<Record<string, unknown>>).map(
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
      setIsLoading(false);
    })();
  }, []);

  const scoped = useMemo(() => {
    if (filters.branchId === "all") return orders;
    return orders.filter((o) => o.branch_id === filters.branchId);
  }, [orders, filters.branchId]);

  const rangePred = (iso: string) => {
    if (filters.range === "today") return isToday(iso);
    if (filters.range === "month") return isThisMonth(iso);
    if (filters.range === "year") return isThisYear(iso);
    return true;
  };
  const rangeOrders = useMemo(
    () => scoped.filter((o) => rangePred(o.created_at)),
    [scoped, filters.range]
  );

  const todayRevenue = sumRevenue(scoped.filter((o) => isToday(o.created_at)));
  const weekRevenue = sumRevenue(scoped.filter((o) => isThisWeek(o.created_at)));
  const monthRevenue = sumRevenue(scoped.filter((o) => isThisMonth(o.created_at)));
  const lastMonthRevenue = sumRevenue(
    scoped.filter((o) => isLastMonth(o.created_at))
  );
  const yearRevenue = sumRevenue(scoped.filter((o) => isThisYear(o.created_at)));
  const totalRevenue = sumRevenue(scoped);
  const monthGrowth = growthPercent(monthRevenue, lastMonthRevenue);

  const branchRows = aggregateByBranch(scoped);
  const topServices = aggregateTopServices(rangeOrders, 8);
  const trendMonths = lastNMonthKeys(6);
  const trend = trendMonths.map((m) => ({
    label: m.label,
    value: sumRevenue(
      scoped.filter((o) => {
        const d = new Date(o.created_at);
        return d.getFullYear() === m.year && d.getMonth() === m.month;
      })
    ),
  }));

  return (
    <ReportFrame
      title="รายงานรายได้"
      description="ภาพรวมยอดขาย รายวัน/สัปดาห์/เดือน/ปี และอัตราการเติบโต"
      toolbar={<ReportFilters value={filters} onChange={setFilters} />}
    >
      {isLoading ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          กำลังโหลด...
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Kpi label="วันนี้" value={formatCurrency(todayRevenue)} tone="green" />
            <Kpi label="7 วันล่าสุด" value={formatCurrency(weekRevenue)} tone="white" />
            <Kpi label="เดือนนี้" value={formatCurrency(monthRevenue)} tone="yellow" />
            <Kpi label="ปีนี้" value={formatCurrency(yearRevenue)} tone="white" />
            <Kpi
              label="เติบโต MoM"
              value={`${monthGrowth >= 0 ? "+" : ""}${monthGrowth}%`}
              tone={monthGrowth >= 0 ? "green" : "red"}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h3 className="text-lg font-bold text-gray-900 mb-3">แนวโน้มรายได้ 6 เดือน</h3>
              <SimpleLineChart data={trend} />
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h3 className="text-lg font-bold text-gray-900 mb-3">รายได้ตามสาขา</h3>
              <SimpleBarChart
                data={branchRows.map((b) => ({ label: b.shortLabel, value: b.revenue }))}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h3 className="text-lg font-bold text-gray-900 mb-3">
              บริการที่ทำรายได้สูงสุด ({filters.range === "all" ? "ตลอด" : "ในช่วงที่เลือก"})
            </h3>
            {topServices.length === 0 ? (
              <p className="text-sm text-gray-500">ไม่มีข้อมูล</p>
            ) : (
              <SimpleBarChart
                data={topServices.map((s) => ({ label: s.label, value: s.revenue }))}
              />
            )}
          </div>

          <p className="text-xs text-gray-500">
            ยอดรวมทั้งหมดในขอบเขตที่เลือก: {formatCurrency(totalRevenue)}
          </p>
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
