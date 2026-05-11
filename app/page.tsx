"use client";

import { useLanguage } from "@/lib/languageContext";
import { t } from "@/lib/translations";
import { StatCard } from "@/components/StatCard";
import { Table } from "@/components/Table";
import { mockRepairOrders, mockDailySales } from "@/lib/mockData";
import { RepairOrder } from "@/types";
import Link from "next/link";
import { formatDate } from "@/lib/utils";

const statusBadges = {
  pending: "bg-yellow-100 text-yellow-800",
  "in-progress": "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  "ready-for-pickup": "bg-purple-100 text-purple-800",
};

const statusLabels = {
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

export default function Dashboard() {
  const { language } = useLanguage();

  const columns = [
    {
      key: "id",
      label: language === "th" ? "เลขที่" : "Order ID",
      width: "100px",
    },
    {
      key: "customerName",
      label: language === "th" ? "ชื่อลูกค้า" : "Customer",
      width: "150px",
    },
    {
      key: "description",
      label: language === "th" ? "รายละเอียด" : "Description",
      width: "200px",
    },
    {
      key: "status",
      label: language === "th" ? "สถานะ" : "Status",
      render: (status: string) => (
        <span
          className={`px-3 py-1 rounded-full text-xs font-medium ${statusBadges[status as keyof typeof statusBadges]}`}
        >
          {statusLabels[language][status as keyof typeof statusLabels.th]}
        </span>
      ),
    },
    {
      key: "totalPrice",
      label: language === "th" ? "ราคา (บาท)" : "Price (฿)",
      render: (price: number) => `฿${price.toLocaleString()}`,
    },
  ];

  return (
    <div className="flex-1 p-4 md:p-8 pt-20 md:pt-8">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-3xl md:text-4xl font-bold text-gray-800">
          {t("dashboard.title", language)}
        </h1>
        <p className="text-gray-600 mt-2">
          {t("dashboard.welcomeMessage", language)}
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-8">
        <StatCard
          title={t("dashboard.dailySales", language)}
          value={`฿${mockDailySales.totalRevenue.toLocaleString()}`}
          icon="💰"
          color="green"
        />
        <StatCard
          title={t("dashboard.totalOrders", language)}
          value={mockDailySales.totalOrders}
          icon="🔧"
          color="blue"
        />
        <StatCard
          title={t("dashboard.completedToday", language)}
          value={mockDailySales.completedOrders}
          icon="✅"
          color="purple"
        />
        <StatCard
          title={t("dashboard.pendingOrders", language)}
          value={mockDailySales.pendingOrders}
          icon="⏳"
          color="orange"
        />
      </div>

      {/* Recent Orders Section */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-gray-800">
            {language === "th" ? "คำสั่งซ่อมล่าสุด" : "Recent Orders"}
          </h2>
          <Link
            href="/orders"
            className="text-blue-600 hover:text-blue-800 font-medium text-sm"
          >
            {language === "th" ? "ดูทั้งหมด →" : "View All →"}
          </Link>
        </div>
        <Table columns={columns} data={mockRepairOrders.slice(0, 5)} />
      </div>

      {/* Quick Stats Footer */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-bold text-gray-800 mb-4">
            {language === "th" ? "สัปดาห์นี้" : "This Week"}
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-gray-600">
                {language === "th" ? "รายได้รวม" : "Total Revenue"}
              </span>
              <span className="font-bold text-gray-800">฿9,500</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">
                {language === "th" ? "จำนวนคำสั่งซ่อม" : "Total Orders"}
              </span>
              <span className="font-bold text-gray-800">12</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">
                {language === "th" ? "มูลค่าเฉลี่ย" : "Average"}
              </span>
              <span className="font-bold text-gray-800">฿792</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-bold text-gray-800 mb-4">
            {language === "th" ? "เดือนนี้" : "This Month"}
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-gray-600">
                {language === "th" ? "รายได้รวม" : "Total Revenue"}
              </span>
              <span className="font-bold text-gray-800">฿45,230</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">
                {language === "th" ? "จำนวนคำสั่งซ่อม" : "Total Orders"}
              </span>
              <span className="font-bold text-gray-800">58</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">
                {language === "th" ? "มูลค่าเฉลี่ย" : "Average"}
              </span>
              <span className="font-bold text-gray-800">฿780</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
