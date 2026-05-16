"use client";

import { useRouter } from "next/navigation";
import { useBranch } from "@/lib/branchContext";
import { BrandLogo } from "@/components/BrandLogo";
import { IntakeOrderForm } from "@/components/IntakeOrderForm";

export default function IntakePage() {
  const { branch } = useBranch();
  const router = useRouter();

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto w-full max-w-lg">
        <div className="mb-5 border-l-4 border-yellow-400 pl-4">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS
          </p>
          <h1 className="text-2xl md:text-3xl font-extrabold text-gray-900">
            รับงานหน้าร้าน
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            กรอกข้อมูลลูกค้าและบริการ ระบบจะคำนวณยอดและออกใบรับงาน/ใบเสนอราคาให้
          </p>
        </div>

        <div className="mb-4 flex items-center gap-3 bg-white border border-green-100 rounded-2xl px-4 py-3 shadow-sm">
          <BrandLogo size="sm" variant="onLight" />
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-gray-500">
              สาขาที่รับงาน
            </p>
            <p className="text-sm font-semibold text-gray-800 truncate">
              {branch.shortLabel}
            </p>
            <p className="text-[11px] text-gray-500 truncate">{branch.address}</p>
          </div>
        </div>

        <IntakeOrderForm
          onCreated={(summary) => {
            // After save, jump straight to the combined document — that's the
            // single receipt the shop now operates from.
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
