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
import {
  aggregateExpensesByCategory,
  computeProfitByBranch,
  filterLastMonthExpenses,
  filterThisMonthExpenses,
  filterTodayExpenses,
  sumExpenses,
  type ExpenseRow,
} from "@/lib/expenses";

interface AccountingDashboardProps {
  orders: AnalyticsOrder[];
  expenses: ExpenseRow[];
}

export function AccountingDashboard({
  orders,
  expenses,
}: AccountingDashboardProps) {
  const todayRevenue = sumRevenue(orders.filter((o) => isToday(o.created_at)));
  const monthRevenue = sumRevenue(
    orders.filter((o) => isThisMonth(o.created_at))
  );
  const lastMonthRevenue = sumRevenue(
    orders.filter((o) => isLastMonth(o.created_at))
  );
  const todayExpense = sumExpenses(filterTodayExpenses(expenses));
  const monthExpense = sumExpenses(filterThisMonthExpenses(expenses));
  const lastMonthExpense = sumExpenses(filterLastMonthExpenses(expenses));
  const payment = aggregatePayments(orders);
  const branchStats = aggregateByBranch(orders);
  const branchProfit = computeProfitByBranch(orders, expenses);
  const expenseByCategory = aggregateExpensesByCategory(expenses).filter(
    (c) => c.total > 0
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="รายได้วันนี้" value={formatCurrency(todayRevenue)} tone="green" />
        <StatCard label="ค่าใช้จ่ายวันนี้" value={formatCurrency(todayExpense)} tone="yellow" />
        <StatCard label="รายได้เดือนนี้" value={formatCurrency(monthRevenue)} tone="white" />
        <StatCard label="ค่าใช้จ่ายเดือนนี้" value={formatCurrency(monthExpense)} tone="red" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="เดือนที่แล้ว (รายได้)"
          value={formatCurrency(lastMonthRevenue)}
          tone="white"
        />
        <StatCard
          label="เดือนที่แล้ว (ค่าใช้จ่าย)"
          value={formatCurrency(lastMonthExpense)}
          tone="white"
        />
        <StatCard
          label="ยอดค้างชำระ"
          value={formatCurrency(payment.unpaidTotal)}
          tone="red"
        />
        <StatCard
          label="กำไรเดือนนี้ (ประมาณการ)"
          value={formatCurrency(monthRevenue - monthExpense)}
          tone={monthRevenue - monthExpense >= 0 ? "green" : "red"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-2xl border border-green-100 bg-white p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-3">กำไรตามสาขา</h3>
          <ul className="space-y-2">
            {branchProfit.map((b) => (
              <li
                key={b.branchId}
                className="flex items-center justify-between rounded-xl border border-gray-200 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="font-medium text-gray-800 truncate">{b.shortLabel}</p>
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
                  <p className="text-[11px] text-gray-500">
                    margin {b.marginPercent}%
                  </p>
                </div>
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
          <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3">
            <p className="text-xs font-medium text-gray-700 mb-2">รายได้ตามสาขา</p>
            <ul className="space-y-1.5 text-sm">
              {branchStats.map((b) => (
                <li key={b.branchId} className="flex items-center justify-between">
                  <span className="text-gray-600 truncate">{b.shortLabel}</span>
                  <span className="font-medium text-gray-800">
                    {formatCurrency(b.revenue)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-lg font-bold text-gray-900 mb-3">
          ค่าใช้จ่ายตามหมวด (สะสมทั้งหมด)
        </h3>
        {expenseByCategory.length === 0 ? (
          <p className="text-sm text-gray-500">
            ยังไม่มีรายการค่าใช้จ่าย — เพิ่มได้ที่หน้า ค่าใช้จ่าย
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {expenseByCategory.map((c) => (
              <li key={c.code} className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-gray-700">
                    {c.labelTh}{" "}
                    <span className="text-xs text-gray-500">({c.count})</span>
                  </span>
                  <span className="font-medium text-gray-800">
                    {formatCurrency(c.total)}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-yellow-400 to-green-500"
                    style={{
                      width: `${
                        expenseByCategory[0]?.total
                          ? Math.min(
                              100,
                              Math.round(
                                (c.total / expenseByCategory[0].total) * 100
                              )
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
