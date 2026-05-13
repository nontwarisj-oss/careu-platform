"use client";

import Link from "next/link";
import { formatCurrency } from "@/lib/utils";
import {
  type AnalyticsOrder,
  aggregatePayments,
  isToday,
} from "@/lib/analytics";

interface FrontDeskDashboardProps {
  orders: AnalyticsOrder[];
  customerCount: number;
}

export function FrontDeskDashboard({
  orders,
  customerCount,
}: FrontDeskDashboardProps) {
  const todaysOrders = orders.filter((o) => isToday(o.created_at));
  const todayRevenue = todaysOrders.reduce((s, o) => s + Number(o.price), 0);
  const pending = orders.filter((o) => o.status === "pending").length;
  const ready = orders.filter((o) => o.status === "ready-for-pickup").length;
  const completedToday = todaysOrders.filter(
    (o) => o.status === "completed"
  ).length;
  const payment = aggregatePayments(orders);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard label="ออเดอร์วันนี้" value={todaysOrders.length} tone="green" />
        <StatCard label="ยอดวันนี้" value={formatCurrency(todayRevenue)} tone="yellow" />
        <StatCard label="รอดำเนิน" value={pending} tone="yellow" />
        <StatCard label="พร้อมรับ" value={ready} tone="purple" />
        <StatCard label="ลูกค้าทั้งหมด" value={customerCount} tone="white" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-2xl border border-green-100 bg-white p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-3">ทางลัด</h3>
          <div className="grid grid-cols-2 gap-2">
            <Link
              href="/intake"
              className="rounded-xl bg-green-700 hover:bg-green-800 text-white text-center py-3 font-semibold"
            >
              รับงานใหม่
            </Link>
            <Link
              href="/customers"
              className="rounded-xl border border-green-600 text-green-700 hover:bg-green-50 text-center py-3 font-semibold"
            >
              ค้นหาลูกค้า
            </Link>
            <Link
              href="/orders"
              className="rounded-xl border border-gray-300 text-gray-700 hover:bg-gray-50 text-center py-3 font-semibold col-span-2"
            >
              ดูคำสั่งซ่อมทั้งหมด
            </Link>
          </div>
        </div>

        <div className="rounded-2xl border border-yellow-200 bg-yellow-50/40 p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-3">การชำระค้างอยู่</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <SummaryRow label="ยังไม่ชำระ" value={payment.unpaid} />
            <SummaryRow label="มัดจำ" value={payment.deposit} />
            <SummaryRow label="ชำระแล้ว" value={payment.paid} />
            <SummaryRow
              label="ยอดค้างชำระ"
              value={formatCurrency(payment.unpaidTotal)}
              emphasised
            />
          </div>
          <p className="mt-3 text-xs text-gray-500">
            ตรวจรายการคำสั่งซ่อมที่ยังไม่ชำระและติดต่อลูกค้าตามนัด
          </p>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        วันนี้เสร็จไปแล้ว {completedToday} รายการ — keep up the great work!
      </p>
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

function SummaryRow({
  label,
  value,
  emphasised,
}: {
  label: string;
  value: string | number;
  emphasised?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-yellow-200 bg-white px-3 py-2 ${
        emphasised ? "col-span-2" : ""
      }`}
    >
      <p className="text-[11px] uppercase tracking-widest text-gray-500">{label}</p>
      <p
        className={`mt-0.5 font-bold ${
          emphasised ? "text-2xl text-yellow-900" : "text-lg text-gray-800"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
