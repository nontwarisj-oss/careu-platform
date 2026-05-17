"use client";

import { useRouter } from "next/navigation";
import { IntakeOrderForm } from "@/components/IntakeOrderForm";

export default function IntakePage() {
  const router = useRouter();

  return (
    // Wide, tablet-first container — the intake form lays itself out in
    // two columns (capture left, sticky summary + save right) on lg+.
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-3 md:p-6 lg:p-8 pt-20 md:pt-6">
      <div className="mx-auto w-full max-w-[1600px]">
        <div className="mb-4 border-l-4 border-yellow-400 pl-4">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS
          </p>
          <h1 className="text-2xl md:text-3xl font-extrabold text-gray-900">
            รับงานหน้าร้าน
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            สาขา → ประเภทงาน → Job ID → ลูกค้า → รายการ — ระบบคำนวณยอดและออกใบรับงานให้
          </p>
        </div>

        <IntakeOrderForm
          onCreated={(summary) => {
            // After save, jump straight to the combined document — that's
            // the single receipt the shop operates from.
            router.push(`/orders/${summary.orderId}/document`);
          }}
        />

        <p className="mt-3 text-[11px] text-gray-500 text-center">
          รับซ่อมได้หลายชิ้นในใบงานเดียว — เพิ่มรายการได้ตามต้องการ
        </p>
      </div>
    </div>
  );
}
