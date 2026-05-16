// Branded 404 for the public site — Phase 27C.
//
// Without this, a missing branch / service slug would fall through to
// the root OPS 404 (admin chrome). This keeps the public header +
// footer and offers the customer a way back in.

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "ไม่พบหน้าที่ค้นหา",
  robots: { index: false, follow: true },
};

export default function PublicNotFound() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-20 text-center">
      <p className="text-6xl font-extrabold text-green-700">404</p>
      <h1 className="mt-3 text-2xl font-bold text-gray-900">
        ไม่พบหน้าที่คุณค้นหา
      </h1>
      <p className="mt-2 text-sm text-gray-600">
        หน้านี้อาจถูกย้าย เปลี่ยนชื่อ หรือไม่มีอยู่แล้ว — เลือกเมนูด้านล่างเพื่อไปต่อ
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link
          href="/website"
          className="rounded-xl bg-green-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-green-800"
        >
          กลับหน้าแรก
        </Link>
        <Link
          href="/services"
          className="rounded-xl border border-gray-200 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          ดูบริการ
        </Link>
        <Link
          href="/branches"
          className="rounded-xl border border-gray-200 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          ดูสาขา
        </Link>
        <Link
          href="/track"
          className="rounded-xl border border-gray-200 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          ติดตามงาน
        </Link>
      </div>
    </div>
  );
}
