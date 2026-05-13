"use client";

import { useState } from "react";
import Link from "next/link";
import { useBranch } from "@/lib/branchContext";
import { BrandLogo } from "@/components/BrandLogo";
import { formatCurrency } from "@/lib/utils";
import {
  SmartOrderForm,
  type SmartOrderCreatedSummary,
} from "@/components/SmartOrderForm";

export default function IntakePage() {
  const { branch } = useBranch();
  const [confirmation, setConfirmation] =
    useState<SmartOrderCreatedSummary | null>(null);

  if (confirmation) {
    return (
      <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
        <div className="mx-auto w-full max-w-md">
          <div className="bg-white rounded-2xl shadow-md border border-green-100 overflow-hidden">
            <div
              className={`bg-gradient-to-r ${branch.accentClass} px-5 py-4 flex items-center gap-3 border-b-4 border-yellow-400 text-white`}
            >
              <BrandLogo size="md" variant="onColor" />
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-widest text-yellow-200 font-semibold">
                  รับงานสำเร็จ
                </p>
                <p className="text-base font-bold leading-tight truncate">
                  {confirmation.branchShortLabel}
                </p>
                <p className="text-[11px] text-white/80 truncate">
                  {confirmation.branchName}
                </p>
              </div>
            </div>

            <div className="p-5 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">เลขที่ใบงาน</span>
                <span className="font-mono">
                  #{confirmation.orderId.slice(0, 8).toUpperCase()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">ลูกค้า</span>
                <span className="font-medium text-gray-800 text-right">
                  {confirmation.customerName}
                  {confirmation.customerTypeLabel
                    ? ` (${confirmation.customerTypeLabel})`
                    : ""}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">เบอร์</span>
                <span className="text-gray-800">
                  {confirmation.customerPhone || "-"}
                </span>
              </div>

              <div className="border-t border-dashed border-gray-200 my-2" />

              <div className="flex justify-between">
                <span className="text-gray-500">บริการ</span>
                <span className="text-gray-800 text-right max-w-[60%] break-words">
                  {confirmation.serviceCategoryLabel} •{" "}
                  {confirmation.serviceName}
                </span>
              </div>
              {confirmation.templateText && (
                <p className="text-xs text-gray-600 bg-gray-50 rounded-md p-2 whitespace-pre-wrap">
                  {confirmation.templateText}
                </p>
              )}
              <div className="flex justify-between">
                <span className="text-gray-500">
                  {confirmation.quantity} × {formatCurrency(confirmation.unitPrice)}
                </span>
                <span className="text-gray-800">
                  {formatCurrency(confirmation.subtotal)}
                </span>
              </div>
              {confirmation.urgent && (
                <div className="flex justify-between">
                  <span className="text-gray-500">ค่างานด่วน</span>
                  <span className="text-gray-800">
                    {formatCurrency(confirmation.urgentFee)}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-500">
                  ส่วนลด ({confirmation.promotionLabel})
                </span>
                <span className="text-gray-800">
                  -{formatCurrency(confirmation.discount)}
                </span>
              </div>
              <div className="flex justify-between items-center pt-2 border-t border-gray-200 mt-2">
                <span className="text-gray-600 font-medium">ยอดรวมสุทธิ</span>
                <span className="text-2xl font-bold text-green-700">
                  {formatCurrency(confirmation.total)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">สถานะ</span>
                <span className="px-3 py-0.5 rounded-full bg-yellow-100 text-yellow-800 text-xs font-medium">
                  รอดำเนิน
                </span>
              </div>
            </div>

            <div className="bg-yellow-50 border-t border-yellow-200 px-5 py-4 text-center">
              <p className="text-sm font-medium text-gray-700">ขอบคุณที่ใช้บริการ</p>
              <p className="text-xs text-green-700 mt-1 italic">{branch.tagline}</p>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-2">
            <Link
              href={`/orders/${confirmation.orderId}/document`}
              className="w-full text-center bg-green-700 hover:bg-green-800 text-white font-semibold py-3 rounded-xl"
            >
              เปิดเอกสารฉบับเต็ม (รับงาน/เสนอราคา/ชำระเงิน)
            </Link>
            <button
              onClick={() => setConfirmation(null)}
              className="w-full border border-green-600 text-green-700 hover:bg-green-50 font-semibold py-3 rounded-xl"
            >
              รับงานใหม่
            </button>
            <Link
              href="/orders"
              className="w-full text-center text-sm text-gray-500 hover:text-gray-700 py-2"
            >
              ดูรายการคำสั่งซ่อมทั้งหมด
            </Link>
          </div>
        </div>
      </div>
    );
  }

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
            กรอกข้อมูลลูกค้าและบริการ ระบบจะคำนวณยอดสุทธิให้อัตโนมัติ
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

        <SmartOrderForm
          variant="intake"
          onCreated={(summary) => setConfirmation(summary)}
        />

        <p className="mt-3 text-[11px] text-gray-500 text-center">
          ภาพ/วิดีโอ/ใบรับงานจะอัปโหลดได้เมื่อระบบ Storage พร้อมใช้งาน
        </p>
      </div>
    </div>
  );
}
