"use client";

import { formatCurrency } from "@/lib/utils";
import {
  type AnalyticsOrder,
  aggregateByBranch,
  aggregateCustomerCohort,
  aggregateTopServices,
  computeProfit,
  growthPercent,
  isLastMonth,
  isThisMonth,
  isThisWeek,
  isThisYear,
  isToday,
  sumRevenue,
} from "@/lib/analytics";

interface ExecutiveDashboardProps {
  orders: AnalyticsOrder[];
  customerCount: number;
}

export function ExecutiveDashboard({
  orders,
  customerCount,
}: ExecutiveDashboardProps) {
  const todayRevenue = sumRevenue(orders.filter((o) => isToday(o.created_at)));
  const weekRevenue = sumRevenue(orders.filter((o) => isThisWeek(o.created_at)));
  const monthRevenue = sumRevenue(
    orders.filter((o) => isThisMonth(o.created_at))
  );
  const lastMonthRevenue = sumRevenue(
    orders.filter((o) => isLastMonth(o.created_at))
  );
  const yearRevenue = sumRevenue(orders.filter((o) => isThisYear(o.created_at)));
  const monthGrowth = growthPercent(monthRevenue, lastMonthRevenue);

  const profit = computeProfit(orders);
  const branches = aggregateByBranch(orders);
  const maxBranchRevenue = Math.max(1, ...branches.map((b) => b.revenue));
  const topServices = aggregateTopServices(orders, 5);
  const cohort = aggregateCustomerCohort(orders, customerCount);

  const pending = orders.filter((o) => o.status === "pending").length;
  const inProgress = orders.filter((o) => o.status === "in-progress").length;
  const completed = orders.filter((o) => o.status === "completed").length;

  return (
    <div className="space-y-6">
      {/* Hero KPI row */}
      <div className="rounded-2xl border-b-4 border-yellow-400 bg-gradient-to-r from-green-800 via-green-700 to-green-900 text-white p-6 shadow-md">
        <p className="text-xs uppercase tracking-[0.2em] text-yellow-200 font-semibold">
          Executive Snapshot
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mt-3">
          <KpiHero label="วันนี้" value={formatCurrency(todayRevenue)} />
          <KpiHero label="7 วันล่าสุด" value={formatCurrency(weekRevenue)} />
          <KpiHero
            label="เดือนนี้"
            value={formatCurrency(monthRevenue)}
            sublabel={`${monthGrowth >= 0 ? "▲" : "▼"} ${Math.abs(monthGrowth)}% เทียบเดือนที่แล้ว`}
          />
          <KpiHero label="ปีนี้" value={formatCurrency(yearRevenue)} />
          <KpiHero
            label="กำไรสุทธิ"
            value={formatCurrency(profit.netProfit)}
            sublabel={`อัตรา ${profit.marginPercent}%`}
          />
        </div>
      </div>

      {/* Profit + cost band */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <KpiCard
          title="รายได้รวมทั้งหมด"
          value={formatCurrency(profit.revenue)}
          tone="green"
        />
        <KpiCard
          title="ต้นทุนสะสม (แรงงาน + วัตถุดิบ + ค่าใช้จ่ายสาขา)"
          value={formatCurrency(
            profit.laborCost + profit.materialCost + profit.branchExpense
          )}
          tone="yellow"
          hint="กรอกข้อมูลผ่านตาราง branch_expenses + คอลัมน์ labor_cost/material_cost บน orders"
        />
        <KpiCard
          title="กำไรขั้นต้น"
          value={formatCurrency(profit.grossProfit)}
          tone="white"
          hint="ปัจจุบันยังไม่มีต้นทุนกรอกไว้ — ตัวเลขเท่ากับรายได้รวม"
        />
      </div>

      {/* Operations + customers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-3">การดำเนินงาน</h3>
          <div className="grid grid-cols-3 gap-3 text-center text-sm">
            <OpsTile label="รอดำเนิน" value={pending} tone="yellow" />
            <OpsTile label="กำลังซ่อม" value={inProgress} tone="blue" />
            <OpsTile label="เสร็จสิ้น" value={completed} tone="green" />
          </div>
          <div className="mt-3 rounded-xl border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
            SLA risk / QC fail / rework count จะมาเมื่อเปิดใช้ตาราง QC และ
            order_attachments อย่างเต็มรูปแบบ
          </div>
        </div>

        <div className="rounded-2xl border border-green-100 bg-white p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-3">ลูกค้า</h3>
          <div className="grid grid-cols-3 gap-3 text-center text-sm">
            <OpsTile label="ทั้งหมด" value={cohort.totalCustomers} tone="white" />
            <OpsTile
              label="ลูกค้าใหม่เดือนนี้"
              value={cohort.newCustomersThisMonth}
              tone="yellow"
            />
            <OpsTile label="ลูกค้าประจำ" value={cohort.repeatCustomers} tone="green" />
          </div>
          <p className="mt-3 text-[11px] text-gray-500">
            VIP customers / lost customers จะเข้ามาเมื่อเปิดใช้ customer_segments
            ที่อิงตาราง orders + customers
          </p>
        </div>
      </div>

      {/* Branch comparison */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-bold text-gray-900">เปรียบเทียบสาขา</h3>
          <span className="text-xs text-gray-500">
            {branches.length} สาขา
          </span>
        </div>
        <ul className="space-y-3">
          {branches.map((b) => (
            <li key={b.branchId} className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-gray-800 truncate">{b.shortLabel}</p>
                  <p className="text-xs text-gray-500">
                    {b.orderCount} ออเดอร์ • ยังไม่ชำระ {b.unpaid}
                  </p>
                </div>
                <p className="font-semibold text-green-700">
                  {formatCurrency(b.revenue)}
                </p>
              </div>
              <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-green-500 to-yellow-400"
                  style={{
                    width: `${Math.round((b.revenue / maxBranchRevenue) * 100)}%`,
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Top services */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-lg font-bold text-gray-900 mb-3">บริการที่ทำรายได้สูงสุด</h3>
        {topServices.length === 0 ? (
          <p className="text-sm text-gray-500">ยังไม่มีข้อมูลบริการ</p>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {topServices.map((s, idx) => (
              <li
                key={s.code}
                className="flex items-center justify-between rounded-xl border border-gray-200 px-3 py-2"
              >
                <div className="min-w-0 flex items-center gap-3">
                  <span className="w-7 h-7 rounded-full bg-green-700 text-white text-xs font-bold grid place-items-center">
                    {idx + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium text-gray-800 truncate">{s.label}</p>
                    <p className="text-xs text-gray-500">{s.orderCount} ครั้ง</p>
                  </div>
                </div>
                <p className="font-semibold text-green-700">
                  {formatCurrency(s.revenue)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[11px] text-gray-500">
        ตัวเลขกำไร/ต้นทุนยังเป็นโครงสร้างพื้นฐาน — เปิดให้กรอก labor_cost,
        material_cost และ branch_expenses เพื่อให้ตัวเลขแม่นยำในเฟสถัดไป
      </p>
    </div>
  );
}

function KpiHero({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string;
  sublabel?: string;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-yellow-200/90 font-semibold">
        {label}
      </p>
      <p className="text-2xl font-extrabold leading-tight">{value}</p>
      {sublabel && (
        <p className="text-[11px] text-green-100/90 mt-0.5">{sublabel}</p>
      )}
    </div>
  );
}

function KpiCard({
  title,
  value,
  tone,
  hint,
}: {
  title: string;
  value: string;
  tone: "green" | "yellow" | "white";
  hint?: string;
}) {
  const toneClass = {
    green: "border-green-100 bg-green-50",
    yellow: "border-yellow-200 bg-yellow-50",
    white: "border-gray-100 bg-white",
  }[tone];
  return (
    <div className={`rounded-2xl border ${toneClass} p-5 shadow-sm`}>
      <p className="text-xs text-gray-600">{title}</p>
      <p className="mt-1 text-3xl font-extrabold text-gray-900">{value}</p>
      {hint && <p className="mt-2 text-[11px] text-gray-500">{hint}</p>}
    </div>
  );
}

function OpsTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "yellow" | "blue" | "green" | "white";
}) {
  const toneClass = {
    yellow: "border-yellow-200 bg-yellow-50 text-yellow-900",
    blue: "border-blue-200 bg-blue-50 text-blue-900",
    green: "border-green-200 bg-green-50 text-green-900",
    white: "border-gray-200 bg-white text-gray-900",
  }[tone];
  return (
    <div className={`rounded-xl border ${toneClass} p-3`}>
      <p className="text-[11px] uppercase tracking-widest opacity-75">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
