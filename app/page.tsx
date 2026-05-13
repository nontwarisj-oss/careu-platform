"use client";

import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/lib/languageContext";
import { useBranch } from "@/lib/branchContext";
import { useRole } from "@/lib/roleContext";
import { BrandLogo } from "@/components/BrandLogo";
import supabase from "@/lib/supabase";
import {
  type AnalyticsOrder,
  filterByBranch,
} from "@/lib/analytics";
import type { ExpenseRow } from "@/lib/expenses";
import {
  DASHBOARD_LABELS,
  getAccessibleDashboards,
  getDefaultDashboard,
  seesAllBranches,
  type DashboardKey,
} from "@/lib/roles";
import { FrontDeskDashboard } from "@/components/dashboard/FrontDeskDashboard";
import { ProductionDashboard } from "@/components/dashboard/ProductionDashboard";
import { AccountingDashboard } from "@/components/dashboard/AccountingDashboard";
import { ManagerDashboard } from "@/components/dashboard/ManagerDashboard";
import { ExecutiveDashboard } from "@/components/dashboard/ExecutiveDashboard";

const WIDE_COLUMNS =
  "id, customer_id, price, status, created_at, branch_id, subtotal, discount, urgent_fee, service_category, service_code, service_name, promotion_code, customer_type, payment_status";

const NARROW_COLUMNS =
  "id, customer_id, price, status, created_at";

export default function Dashboard() {
  const { language } = useLanguage();
  const { branch } = useBranch();
  const { role, definition } = useRole();

  const [orders, setOrders] = useState<AnalyticsOrder[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [customerCount, setCustomerCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeDashboard, setActiveDashboard] = useState<DashboardKey>(
    getDefaultDashboard(role)
  );

  // Keep the active tab in sync with the selected role.
  useEffect(() => {
    setActiveDashboard(getDefaultDashboard(role));
  }, [role]);

  useEffect(() => {
    void (async () => {
      setIsLoading(true);
      setErrorMessage(null);

      let rawRows: Array<Record<string, unknown>> | null = null;
      const wide = await supabase
        .from("orders")
        .select(WIDE_COLUMNS)
        .order("created_at", { ascending: false });
      if (!wide.error) {
        rawRows = (wide.data ?? []) as unknown as Array<Record<string, unknown>>;
      } else {
        const narrow = await supabase
          .from("orders")
          .select(NARROW_COLUMNS)
          .order("created_at", { ascending: false });
        if (narrow.error) {
          setErrorMessage(narrow.error.message);
          setOrders([]);
          setIsLoading(false);
          return;
        }
        rawRows = (narrow.data ?? []) as unknown as Array<Record<string, unknown>>;
      }

      setOrders(
        rawRows.map((row) => ({
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
        }))
      );

      const { count } = await supabase
        .from("customers")
        .select("id", { count: "exact", head: true });
      setCustomerCount(count ?? 0);

      // Expenses (optional — table may not exist yet on older deployments).
      const expRes = await supabase
        .from("expenses")
        .select(
          "id, expense_date, category, description, amount, branch_id, payment_method, notes, created_by, created_at"
        )
        .order("expense_date", { ascending: false });
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

  const scopedOrders = useMemo(
    () => filterByBranch(orders, branch.id, seesAllBranches(role)),
    [orders, branch.id, role]
  );

  const accessible = getAccessibleDashboards(role);

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      {/* Page Header */}
      <div className="mb-5 md:mb-6 flex flex-col md:flex-row md:items-end md:justify-between gap-4 border-l-4 border-yellow-400 pl-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS • {definition.labelTh}
          </p>
          <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
            แดชบอร์ด
          </h1>
          <p className="text-gray-600 mt-1 text-sm md:text-base">
            มุมมองตามบทบาท — เปลี่ยนบทบาทได้ที่แถบด้านซ้าย
          </p>
        </div>
        <div className="flex items-center gap-3 bg-white rounded-2xl border border-green-100 shadow-sm px-4 py-2">
          <BrandLogo size="sm" variant="onLight" />
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-gray-500">
              {language === "th" ? "สาขาที่เลือก" : "Current branch"}
            </p>
            <p className="text-sm font-semibold text-gray-800 truncate max-w-[220px]">
              {seesAllBranches(role)
                ? language === "th"
                  ? "ทุกสาขา"
                  : "All branches"
                : branch.shortLabel}
            </p>
            <p className="text-[10px] text-gray-500 truncate max-w-[220px]">
              {seesAllBranches(role) ? branch.shortLabel : branch.address}
            </p>
          </div>
        </div>
      </div>

      {errorMessage && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {/* Dashboard tabs (only when role has more than one) */}
      {accessible.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {accessible.map((key) => {
            const isActive = key === activeDashboard;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setActiveDashboard(key)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                  isActive
                    ? "bg-green-700 border-green-700 text-white"
                    : "bg-white border-gray-200 text-gray-700 hover:bg-green-50"
                }`}
              >
                {DASHBOARD_LABELS[key].th}
              </button>
            );
          })}
        </div>
      )}

      {isLoading ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          กำลังโหลด...
        </div>
      ) : (
        <DashboardView
          dashboard={activeDashboard}
          orders={scopedOrders}
          allOrders={orders}
          expenses={expenses}
          branchId={branch.id}
          customerCount={customerCount}
        />
      )}
    </div>
  );
}

function DashboardView({
  dashboard,
  orders,
  allOrders,
  expenses,
  branchId,
  customerCount,
}: {
  dashboard: DashboardKey;
  orders: AnalyticsOrder[];
  allOrders: AnalyticsOrder[];
  expenses: ExpenseRow[];
  branchId: string;
  customerCount: number;
}) {
  switch (dashboard) {
    case "frontdesk":
      return <FrontDeskDashboard orders={orders} customerCount={customerCount} />;
    case "production":
      return <ProductionDashboard orders={orders} />;
    case "accounting":
      // Accounting reads org-wide so they always see consolidated revenue.
      return <AccountingDashboard orders={allOrders} expenses={expenses} />;
    case "manager":
      return (
        <ManagerDashboard
          orders={allOrders}
          expenses={expenses}
          branchId={branchId}
        />
      );
    case "executive":
      return (
        <ExecutiveDashboard
          orders={allOrders}
          expenses={expenses}
          customerCount={customerCount}
        />
      );
    default:
      return <FrontDeskDashboard orders={orders} customerCount={customerCount} />;
  }
}
