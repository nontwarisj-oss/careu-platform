"use client";

import { useEffect, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import {
  aggregateByBranch,
  type AnalyticsOrder,
} from "@/lib/analytics";
import {
  aggregateExpensesByBranch,
  computeProfitByBranch,
  type ExpenseRow,
} from "@/lib/expenses";
import { ReportFrame } from "@/components/reports/ReportFrame";
import { SimpleBarChart } from "@/components/charts/SimpleBarChart";

export default function BranchesReportPage() {
  const [orders, setOrders] = useState<AnalyticsOrder[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const [ordRes, expRes] = await Promise.all([
        supabase
          .from("orders")
          .select(
            "id, customer_id, price, status, created_at, branch_id, subtotal, discount, urgent_fee, service_category, service_code, service_name, promotion_code, customer_type, payment_status"
          ),
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

  const revenueByBranch = aggregateByBranch(orders);
  const expenseByBranch = aggregateExpensesByBranch(expenses);
  const profit = computeProfitByBranch(orders, expenses);

  return (
    <ReportFrame
      title="รายงานสาขา"
      description="เปรียบเทียบสาขา: รายได้ ค่าใช้จ่าย และกำไร"
    >
      {isLoading ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          กำลังโหลด...
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h3 className="text-lg font-bold text-gray-900 mb-3">รายได้ตามสาขา</h3>
              <SimpleBarChart
                data={revenueByBranch.map((b) => ({
                  label: b.shortLabel,
                  value: b.revenue,
                  secondaryValue:
                    expenseByBranch.find((e) => e.branchId === b.branchId)?.total ?? 0,
                }))}
              />
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h3 className="text-lg font-bold text-gray-900 mb-3">ค่าใช้จ่ายตามสาขา</h3>
              <SimpleBarChart
                data={expenseByBranch.map((b) => ({
                  label: b.shortLabel,
                  value: b.total,
                }))}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h3 className="text-lg font-bold text-gray-900 mb-3">กำไรตามสาขา</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="text-left p-3">สาขา</th>
                    <th className="text-right p-3">รายได้</th>
                    <th className="text-right p-3">ค่าใช้จ่าย</th>
                    <th className="text-right p-3">กำไรสุทธิ</th>
                    <th className="text-right p-3">อัตรากำไร</th>
                  </tr>
                </thead>
                <tbody>
                  {profit.map((b) => (
                    <tr key={b.branchId} className="border-t border-gray-100">
                      <td className="p-3 font-medium text-gray-800">{b.shortLabel}</td>
                      <td className="p-3 text-right text-gray-800">
                        {formatCurrency(b.revenue)}
                      </td>
                      <td className="p-3 text-right text-gray-800">
                        {formatCurrency(b.expense)}
                      </td>
                      <td
                        className={`p-3 text-right font-semibold ${
                          b.netProfit >= 0 ? "text-green-700" : "text-red-700"
                        }`}
                      >
                        {formatCurrency(b.netProfit)}
                      </td>
                      <td className="p-3 text-right text-gray-700">{b.marginPercent}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </ReportFrame>
  );
}
