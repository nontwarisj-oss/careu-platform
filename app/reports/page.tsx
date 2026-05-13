"use client";

import Link from "next/link";
import { ReportFrame } from "@/components/reports/ReportFrame";

const REPORTS = [
  {
    href: "/reports/revenue",
    title: "รายได้",
    description: "ยอดขาย รายวัน/เดือน/ปี และอัตราการเติบโต",
    accent: "from-green-500 to-emerald-500",
  },
  {
    href: "/reports/expenses",
    title: "ค่าใช้จ่าย",
    description: "ค่าใช้จ่ายตามหมวด สาขา และเดือน",
    accent: "from-yellow-500 to-amber-500",
  },
  {
    href: "/reports/profit",
    title: "กำไร",
    description: "กำไรขั้นต้น/สุทธิ อัตรากำไร และกำไรตามสาขา",
    accent: "from-green-700 to-yellow-500",
  },
  {
    href: "/reports/customers",
    title: "ลูกค้า",
    description: "ลูกค้าใหม่/ประจำ/VIP และลูกค้ารายใหญ่",
    accent: "from-blue-500 to-purple-500",
  },
  {
    href: "/reports/branches",
    title: "สาขา",
    description: "เปรียบเทียบสาขา รายได้ ค่าใช้จ่าย และกำไร",
    accent: "from-emerald-600 to-green-800",
  },
];

export default function ReportsIndexPage() {
  return (
    <ReportFrame
      title="รายงาน"
      description="เลือกหัวข้อรายงานที่ต้องการดู — ทุกหน้าพิมพ์ได้และพร้อมต่อยอด export Excel/PDF"
      printable={false}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORTS.map((r) => (
          <Link
            key={r.href}
            href={r.href}
            className="group rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden hover:shadow-md transition"
          >
            <div className={`h-1.5 bg-gradient-to-r ${r.accent}`} />
            <div className="p-5">
              <p className="text-[10px] uppercase tracking-widest text-green-700 font-semibold">
                CareU OPS
              </p>
              <h3 className="mt-1 text-xl font-bold text-gray-900 group-hover:text-green-700">
                {r.title}
              </h3>
              <p className="mt-2 text-sm text-gray-600">{r.description}</p>
              <p className="mt-4 text-sm font-medium text-green-700 group-hover:text-green-800">
                เปิดรายงาน →
              </p>
            </div>
          </Link>
        ))}
      </div>
    </ReportFrame>
  );
}
