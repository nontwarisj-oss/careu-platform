"use client";

import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/lib/languageContext";
import { t } from "@/lib/translations";
import { StatCard } from "@/components/StatCard";
import { Table } from "@/components/Table";
import supabase from "@/lib/supabase";
import Link from "next/link";

type OrderRow = {
  id: string;
  customer_name: string;
  item_name: string;
  price: number;
  status: string;
  created_at: string;
};

type RecentOrder = {
  id: string;
  customerName: string;
  itemName: string;
  status: string;
  price: number;
};

const statusBadges: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  "in-progress": "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  "ready-for-pickup": "bg-purple-100 text-purple-800",
};

const statusLabels: Record<"th" | "en", Record<string, string>> = {
  th: {
    pending: "รอดำเนิน",
    "in-progress": "กำลังซ่อม",
    completed: "เสร็จสิ้น",
    "ready-for-pickup": "พร้อมรับ",
  },
  en: {
    pending: "Pending",
    "in-progress": "In Progress",
    completed: "Completed",
    "ready-for-pickup": "Ready",
  },
};

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export default function Dashboard() {
  const { language } = useLanguage();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setIsLoading(true);
      setErrorMessage(null);
      const { data, error } = await supabase
        .from("orders")
        .select("id, customer_name, item_name, price, status, created_at")
        .order("created_at", { ascending: false });

      if (error) {
        setErrorMessage(error.message);
        setOrders([]);
      } else {
        setOrders((data ?? []) as OrderRow[]);
      }
      setIsLoading(false);
    })();
  }, []);

  const todaysOrders = useMemo(() => orders.filter((o) => isToday(o.created_at)), [orders]);

  const stats = useMemo(() => {
    const dailyRevenue = todaysOrders.reduce((sum, o) => sum + Number(o.price ?? 0), 0);
    const todayOrderCount = todaysOrders.length;
    const totalPending = orders.filter((o) => o.status === "pending").length;
    const totalInProgress = orders.filter((o) => o.status === "in-progress").length;
    const totalCompleted = orders.filter((o) => o.status === "completed").length;
    const activeWorkload = totalPending + totalInProgress;
    const totalCount = orders.length;
    const completionRate =
      totalCount > 0 ? Math.round((totalCompleted / totalCount) * 100) : 0;
    return {
      dailyRevenue,
      todayOrderCount,
      totalPending,
      totalInProgress,
      totalCompleted,
      activeWorkload,
      totalCount,
      completionRate,
    };
  }, [orders, todaysOrders]);

  const recentOrders: RecentOrder[] = useMemo(
    () =>
      orders.slice(0, 5).map((o) => ({
        id: o.id,
        customerName: o.customer_name,
        itemName: o.item_name,
        status: o.status,
        price: Number(o.price ?? 0),
      })),
    [orders]
  );

  const columns = [
    {
      key: "id",
      label: language === "th" ? "เลขที่" : "Order ID",
      width: "120px",
      render: (id: string) => <span className="font-mono text-xs">{id.slice(0, 8)}</span>,
    },
    {
      key: "customerName",
      label: language === "th" ? "ชื่อลูกค้า" : "Customer",
      width: "180px",
    },
    {
      key: "itemName",
      label: language === "th" ? "รายการ" : "Item",
      width: "200px",
    },
    {
      key: "status",
      label: language === "th" ? "สถานะ" : "Status",
      render: (status: string) => (
        <span
          className={`px-3 py-1 rounded-full text-xs font-medium ${
            statusBadges[status] ?? "bg-gray-100 text-gray-700"
          }`}
        >
          {statusLabels[language][status] ?? status}
        </span>
      ),
    },
    {
      key: "price",
      label: language === "th" ? "ราคา (บาท)" : "Price (฿)",
      render: (price: number) => (
        <span className="font-semibold text-green-700">
          ฿{price.toLocaleString()}
        </span>
      ),
    },
  ];

  return (
    <div className="flex-1 p-4 md:p-8 pt-20 md:pt-8 bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 min-h-screen">
      {/* Page Header */}
      <div className="mb-6 md:mb-8 border-l-4 border-yellow-400 pl-4">
        <h1 className="text-3xl md:text-4xl font-bold text-gray-800">
          {t("dashboard.title", language)}
        </h1>
        <p className="text-gray-600 mt-1 text-sm md:text-base">
          {t("dashboard.welcomeMessage", language)}
        </p>
      </div>

      {errorMessage && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {/* Today Hero */}
      <div className="bg-gradient-to-r from-green-700 to-green-600 rounded-2xl shadow-md p-6 md:p-8 mb-6 md:mb-8 border-b-4 border-yellow-400 text-white">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-yellow-200 font-semibold">
              {language === "th" ? "วันนี้" : "Today"}
            </p>
            <p className="text-4xl md:text-5xl font-extrabold mt-1">
              ฿{stats.dailyRevenue.toLocaleString()}
            </p>
            <p className="text-sm text-green-100 mt-1">
              {t("dashboard.dailySales", language)}
            </p>
          </div>
          <div className="flex flex-col items-start md:items-end">
            <p className="text-3xl md:text-4xl font-bold text-yellow-300">
              {stats.todayOrderCount}
            </p>
            <p className="text-sm text-green-100">
              {language === "th" ? "คำสั่งซ่อมวันนี้" : "Orders today"}
            </p>
          </div>
        </div>
      </div>

      {/* Status Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 md:gap-6 mb-6 md:mb-8">
        <StatCard
          title={t("orders.pending", language)}
          value={stats.totalPending}
          icon={<span className="text-xl font-bold">P</span>}
          color="yellow"
        />
        <StatCard
          title={t("orders.inProgress", language)}
          value={stats.totalInProgress}
          icon={<span className="text-xl font-bold">W</span>}
          color="blue"
        />
        <StatCard
          title={t("orders.completed", language)}
          value={stats.totalCompleted}
          icon={<span className="text-xl font-bold">C</span>}
          color="green"
        />
      </div>

      {/* Recent Orders + Operational Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-gray-200 p-5 md:p-6">
          <div className="flex items-center justify-between mb-4 md:mb-6">
            <h2 className="text-lg md:text-xl font-bold text-gray-800">
              {language === "th" ? "คำสั่งซ่อมล่าสุด" : "Recent Orders"}
            </h2>
            <Link
              href="/orders"
              className="text-green-700 hover:text-green-800 font-medium text-sm"
            >
              {language === "th" ? "ดูทั้งหมด →" : "View All →"}
            </Link>
          </div>
          {isLoading ? (
            <div className="p-8 text-center text-gray-500">
              {language === "th" ? "กำลังโหลด..." : "Loading..."}
            </div>
          ) : (
            <Table
              columns={columns}
              data={recentOrders}
              emptyMessage={language === "th" ? "ไม่มีคำสั่งซ่อม" : "No orders yet"}
            />
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5 md:p-6">
          <h2 className="text-lg md:text-xl font-bold text-gray-800 mb-4 md:mb-6">
            {language === "th" ? "สรุปการดำเนินงาน" : "Operations Summary"}
          </h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <span className="text-sm text-gray-600">
                {language === "th" ? "งานที่ยังไม่เสร็จ" : "Active workload"}
              </span>
              <span className="text-2xl font-bold text-gray-800">
                {stats.activeWorkload}
              </span>
            </div>
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <span className="text-sm text-gray-600">
                {language === "th" ? "คำสั่งซ่อมทั้งหมด" : "Total orders"}
              </span>
              <span className="text-2xl font-bold text-gray-800">
                {stats.totalCount}
              </span>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">
                  {language === "th" ? "อัตราเสร็จสิ้น" : "Completion rate"}
                </span>
                <span className="text-sm font-semibold text-green-700">
                  {stats.completionRate}%
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-green-500 to-yellow-400"
                  style={{ width: `${stats.completionRate}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
