"use client";

import { formatCurrency } from "@/lib/utils";
import {
  type AnalyticsOrder,
  aggregateByBranch,
  aggregatePayments,
  isLastMonth,
  isThisMonth,
  isToday,
  sumRevenue,
} from "@/lib/analytics";

interface AccountingDashboardProps {
  orders: AnalyticsOrder[];
}

export function AccountingDashboard({ orders }: AccountingDashboardProps) {
  const todayRevenue = sumRevenue(orders.filter((o) => isToday(o.created_at)));
  const monthRevenue = sumRevenue(
    orders.filter((o) => isThisMonth(o.created_at))
  );
  const lastMonthRevenue = sumRevenue(
    orders.filter((o) => isLastMonth(o.created_at))
  );
  const payment = aggregatePayments(orders);
  const branchStats = aggregateByBranch(orders);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="รายได้วันนี้" value={formatCurrency(todayRevenue)} tone="green" />
        <StatCard label="รายได้เดือนนี้" value={formatCurrency(monthRevenue)} tone="yellow" />
        <StatCard label="เดือนที่แล้ว" value={formatCurrency(lastMonthRevenue)} tone="white" />
        <StatCard
          label="ยอดค้างชำระ"
          value={formatCurrency(payment.unpaidTotal)}
          tone="red"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-2xl border border-green-100 bg-white p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-3">รายได้ตามสาขา</h3>
          <ul className="space-y-2">
            {branchStats.map((b) => (
              <li
                key={b.branchId}
                className="flex items-center justify-between rounded-xl border border-gray-200 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="font-medium text-gray-800 truncate">{b.shortLabel}</p>
                  <p className="text-xs text-gray-500">
                    {b.orderCount} ออเดอร์ • ยังไม่ชำระ {b.unpaid}
                  </p>
                </div>
                <p className="font-semibold text-green-700">
                  {formatCurrency(b.revenue)}
                </p>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-2xl border border-yellow-200 bg-yellow-50/40 p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-3">สถานะการชำระ</h3>
          <ul className="grid grid-cols-3 gap-2 text-center">
            <PaymentTile label="ชำระแล้ว" value={payment.paid} tone="green" />
            <PaymentTile label="มัดจำ" value={payment.deposit} tone="blue" />
            <PaymentTile label="ยังไม่ชำระ" value={payment.unpaid} tone="yellow" />
          </ul>
          <div className="mt-4 rounded-xl border border-dashed border-yellow-300 bg-white p-3 text-xs text-gray-600">
            QR payment tracking & expense entries จะเข้ามาเมื่อเปิดใช้ตาราง
            branch_expenses ที่เพิ่งสร้าง (migration 20260516)
          </div>
        </div>
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
  value: string;
  tone: "green" | "yellow" | "red" | "white";
}) {
  const toneClass = {
    green: "border-green-100 bg-green-50 text-green-900",
    yellow: "border-yellow-100 bg-yellow-50 text-yellow-900",
    red: "border-red-100 bg-red-50 text-red-900",
    white: "border-gray-100 bg-white text-gray-900",
  }[tone];
  return (
    <div className={`rounded-2xl border ${toneClass} p-4 shadow-sm`}>
      <p className="text-xs opacity-75">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

function PaymentTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "green" | "blue" | "yellow";
}) {
  const toneClass = {
    green: "border-green-200 bg-green-50 text-green-900",
    blue: "border-blue-200 bg-blue-50 text-blue-900",
    yellow: "border-yellow-200 bg-white text-yellow-900",
  }[tone];
  return (
    <li className={`rounded-xl border ${toneClass} p-3`}>
      <p className="text-[11px] uppercase tracking-widest opacity-75">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </li>
  );
}
