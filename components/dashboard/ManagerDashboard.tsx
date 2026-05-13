"use client";

import { formatCurrency } from "@/lib/utils";
import {
  type AnalyticsOrder,
  aggregateByBranch,
  aggregateByCategory,
  aggregateTopServices,
  isThisMonth,
  isToday,
  sumRevenue,
} from "@/lib/analytics";

interface ManagerDashboardProps {
  orders: AnalyticsOrder[];
  branchId: string;
}

export function ManagerDashboard({ orders, branchId }: ManagerDashboardProps) {
  const scoped = orders.filter((o) => o.branch_id === branchId || !o.branch_id);
  const todayRevenue = sumRevenue(scoped.filter((o) => isToday(o.created_at)));
  const monthRevenue = sumRevenue(scoped.filter((o) => isThisMonth(o.created_at)));
  const pending = scoped.filter((o) => o.status === "pending").length;
  const inProgress = scoped.filter((o) => o.status === "in-progress").length;
  const completed = scoped.filter((o) => o.status === "completed").length;
  const conversion =
    scoped.length > 0 ? Math.round((completed / scoped.length) * 100) : 0;

  const topServices = aggregateTopServices(scoped, 5);
  const byCategory = aggregateByCategory(scoped).slice(0, 4);
  const allBranches = aggregateByBranch(orders);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard label="รายได้วันนี้" value={formatCurrency(todayRevenue)} tone="green" />
        <StatCard label="รายได้เดือนนี้" value={formatCurrency(monthRevenue)} tone="yellow" />
        <StatCard label="งานในคิว" value={pending + inProgress} tone="blue" />
        <StatCard label="อัตราเสร็จงาน" value={`${conversion}%`} tone="white" />
        <StatCard label="งานเสร็จทั้งหมด" value={completed} tone="purple" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-2xl border border-green-100 bg-white p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-3">บริการที่ขายดี</h3>
          {topServices.length === 0 ? (
            <p className="text-sm text-gray-500">ยังไม่มีข้อมูลในสาขานี้</p>
          ) : (
            <ul className="space-y-2">
              {topServices.map((s) => (
                <li
                  key={s.code}
                  className="flex items-center justify-between rounded-xl border border-gray-200 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-gray-800 truncate">{s.label}</p>
                    <p className="text-xs text-gray-500">{s.orderCount} ครั้ง</p>
                  </div>
                  <p className="font-semibold text-green-700">
                    {formatCurrency(s.revenue)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-yellow-200 bg-yellow-50/40 p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-3">หมวดบริการ</h3>
          <ul className="space-y-2 text-sm">
            {byCategory.map((c) => (
              <li key={c.code} className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-gray-700">{c.labelTh}</span>
                  <span className="font-medium text-gray-800">
                    {formatCurrency(c.revenue)}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-yellow-100 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-green-500 to-yellow-400"
                    style={{
                      width: `${
                        byCategory[0]?.revenue
                          ? Math.min(
                              100,
                              Math.round((c.revenue / byCategory[0].revenue) * 100)
                            )
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-lg font-bold text-gray-900 mb-3">เปรียบเทียบสาขา</h3>
        <ul className="space-y-2 text-sm">
          {allBranches.map((b) => (
            <li
              key={b.branchId}
              className={`flex items-center justify-between rounded-xl border px-3 py-2 ${
                b.branchId === branchId
                  ? "border-green-300 bg-green-50/40"
                  : "border-gray-200"
              }`}
            >
              <div className="min-w-0">
                <p className="font-medium text-gray-800 truncate">{b.shortLabel}</p>
                <p className="text-xs text-gray-500">{b.orderCount} ออเดอร์</p>
              </div>
              <p className="font-semibold text-gray-800">
                {formatCurrency(b.revenue)}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone: "green" | "yellow" | "blue" | "purple" | "white";
}) {
  const toneClass = {
    green: "border-green-100 bg-green-50 text-green-900",
    yellow: "border-yellow-100 bg-yellow-50 text-yellow-900",
    blue: "border-blue-100 bg-blue-50 text-blue-900",
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
