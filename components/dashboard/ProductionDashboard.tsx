"use client";

import Link from "next/link";
import { formatCurrency } from "@/lib/utils";
import { type AnalyticsOrder } from "@/lib/analytics";
import { getServiceByCode } from "@/lib/pricing";
import { OrderStatusBadge } from "@/components/StatusBadge";

interface ProductionDashboardProps {
  orders: AnalyticsOrder[];
}

const SLA_DAYS = 5;

export function ProductionDashboard({ orders }: ProductionDashboardProps) {
  const now = Date.now();
  const inProgress = orders.filter((o) => o.status === "in-progress");
  const pending = orders.filter((o) => o.status === "pending");
  const ready = orders.filter((o) => o.status === "ready-for-pickup");

  const overdue = inProgress.filter(
    (o) =>
      (now - new Date(o.created_at).getTime()) / (1000 * 60 * 60 * 24) > SLA_DAYS
  );

  const workload = [...pending, ...inProgress]
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )
    .slice(0, 12);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="กำลังซ่อม" value={inProgress.length} tone="blue" />
        <StatCard label="รอดำเนิน" value={pending.length} tone="yellow" />
        <StatCard label="เกิน SLA" value={overdue.length} tone="red" />
        <StatCard label="พร้อมรับ" value={ready.length} tone="purple" />
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-100 p-4">
          <div>
            <h3 className="text-lg font-bold text-gray-900">คิวงานที่ต้องทำ</h3>
            <p className="text-xs text-gray-500">
              เรียงตามเวลารับเข้า • SLA {SLA_DAYS} วัน
            </p>
          </div>
          <Link
            href="/orders"
            className="text-sm text-green-700 hover:text-green-800 font-medium"
          >
            ดูทั้งหมด →
          </Link>
        </div>
        {workload.length === 0 ? (
          <p className="p-8 text-center text-gray-500">ไม่มีคิวงานในตอนนี้</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {workload.map((o) => {
              const ageHours =
                (now - new Date(o.created_at).getTime()) / (1000 * 60 * 60);
              const ageDays = Math.floor(ageHours / 24);
              const isOverdue = ageDays > SLA_DAYS;
              const service =
                o.service_name ??
                getServiceByCode(o.service_code ?? undefined)?.nameTh ??
                "งานซ่อม";
              return (
                <Link
                  key={o.id}
                  href={`/orders/${o.id}/document`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-green-50/40"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-gray-800 truncate">{service}</p>
                    <p className="text-xs text-gray-500 truncate">
                      #{o.id.slice(0, 8).toUpperCase()} •{" "}
                      {new Date(o.created_at).toLocaleDateString("th-TH")} •{" "}
                      <span
                        className={isOverdue ? "text-red-600" : "text-gray-500"}
                      >
                        อายุ {ageDays} วัน
                      </span>
                    </p>
                  </div>
                  <OrderStatusBadge status={o.status} />
                  <span className="sr-only">{o.status}</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-5 text-sm text-gray-600">
        QC checklist, รูปก่อน/หลังซ่อม และโน้ตช่างจะอยู่ที่นี่เมื่อระบบ Storage และตาราง
        order_attachments พร้อมใช้งานเต็มรูปแบบ
      </div>

      <p className="text-xs text-gray-500">
        ยอดงานทั้งหมดในระบบมูลค่า {formatCurrency(
          [...pending, ...inProgress].reduce((s, o) => s + Number(o.price), 0)
        )}{" "}
        — ใช้สำหรับวางแผนกำลังการผลิต
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
  tone: "blue" | "yellow" | "red" | "purple";
}) {
  const toneClass = {
    blue: "border-blue-100 bg-blue-50 text-blue-900",
    yellow: "border-yellow-100 bg-yellow-50 text-yellow-900",
    red: "border-red-100 bg-red-50 text-red-900",
    purple: "border-purple-100 bg-purple-50 text-purple-900",
  }[tone];
  return (
    <div className={`rounded-2xl border ${toneClass} p-4 shadow-sm`}>
      <p className="text-xs opacity-75">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
