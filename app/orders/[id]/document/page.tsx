"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useBranch } from "@/lib/branchContext";
import { getBranchById } from "@/lib/brandConfig";
import { BrandLogo } from "@/components/BrandLogo";
import {
  buildCustomerMessage,
  categoryLabelFor,
  formatPaymentStatus,
  promotionLabelFor,
  serviceLabelFor,
  type DocumentOrder,
} from "@/lib/customerMessage";
import { getCustomerTypeByCode } from "@/lib/pricing";
import { sendToLineOA } from "@/lib/lineOA";

type RouteParams = { id: string };

const statusLabelTh: Record<string, string> = {
  pending: "รอดำเนิน",
  "in-progress": "กำลังซ่อม",
  completed: "เสร็จสิ้น",
  "ready-for-pickup": "พร้อมรับ",
};

const statusBadgeClasses: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 border-yellow-300",
  "in-progress": "bg-blue-100 text-blue-800 border-blue-300",
  completed: "bg-green-100 text-green-800 border-green-300",
  "ready-for-pickup": "bg-purple-100 text-purple-800 border-purple-300",
};

const paymentBadgeClasses: Record<string, string> = {
  unpaid: "bg-yellow-100 text-yellow-800 border-yellow-300",
  paid: "bg-green-100 text-green-800 border-green-300",
  deposit: "bg-blue-100 text-blue-800 border-blue-300",
};

const PAYMENT_OPTIONS = [
  { value: "unpaid", label: "ยังไม่ชำระ" },
  { value: "deposit", label: "มัดจำ" },
  { value: "paid", label: "ชำระแล้ว" },
];

export default function OrderDocumentPage({
  params,
}: {
  params: Promise<RouteParams>;
}) {
  const { id: orderId } = use(params);
  const { branch: currentBranch } = useBranch();

  const [order, setOrder] = useState<DocumentOrder | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [orderBranchId, setOrderBranchId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [paymentSaving, setPaymentSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      setIsLoading(true);
      setErrorMessage(null);

      // Try the widest column set, then narrow on column-missing errors so the
      // page renders on any migration state (legacy / intake-extension / smart /
      // smart+payment).
      const wide =
        "id, customer_id, customer_name, item_name, price, status, created_at, notes, urgent, urgent_fee, branch_id, subtotal, discount, quantity, service_category, service_code, service_name, template_text, customer_type, promotion_code, payment_status, payment_method";
      let raw: Record<string, unknown> | null = null;

      const tryFetch = async (cols: string) =>
        await supabase
          .from("orders")
          .select(cols)
          .eq("id", orderId)
          .maybeSingle();

      const tries = [
        wide,
        // drop payment_* and document_type
        "id, customer_id, customer_name, item_name, price, status, created_at, notes, urgent, urgent_fee, branch_id, subtotal, discount, quantity, service_category, service_code, service_name, template_text, customer_type, promotion_code",
        // drop smart cols
        "id, customer_id, customer_name, item_name, price, status, created_at, notes, urgent, urgent_fee, branch_id",
        // legacy
        "id, customer_id, customer_name, item_name, price, status, created_at",
      ];
      for (const cols of tries) {
        const res = await tryFetch(cols);
        if (!res.error && res.data) {
          raw = res.data as unknown as Record<string, unknown>;
          break;
        }
      }

      if (!raw) {
        setErrorMessage("ไม่พบใบงาน หรือใบงานถูกลบไปแล้ว");
        setIsLoading(false);
        return;
      }

      const customerId = (raw.customer_id as string | null) ?? null;
      let phone: string | null = null;
      if (customerId) {
        const cust = await supabase
          .from("customers")
          .select("phone")
          .eq("id", customerId)
          .maybeSingle();
        if (cust.data && (cust.data as { phone?: string }).phone) {
          phone = (cust.data as { phone: string }).phone;
        }
      }

      setOrderBranchId((raw.branch_id as string | null) ?? null);

      setOrder({
        id: String(raw.id),
        customer_name: (raw.customer_name as string) ?? "",
        customer_phone: phone,
        item_name: (raw.item_name as string) ?? "",
        price: Number(raw.price ?? 0),
        subtotal:
          raw.subtotal !== null && raw.subtotal !== undefined
            ? Number(raw.subtotal)
            : null,
        discount: Number(raw.discount ?? 0),
        urgent: Boolean(raw.urgent),
        urgent_fee: Number(raw.urgent_fee ?? 0),
        quantity: Number(raw.quantity ?? 1),
        status: (raw.status as string) ?? "pending",
        notes: (raw.notes as string) ?? null,
        service_category: (raw.service_category as string) ?? null,
        service_code: (raw.service_code as string) ?? null,
        service_name: (raw.service_name as string) ?? null,
        template_text: (raw.template_text as string) ?? null,
        customer_type: (raw.customer_type as string) ?? null,
        promotion_code: (raw.promotion_code as string) ?? null,
        payment_status: (raw.payment_status as string) ?? "unpaid",
        created_at: (raw.created_at as string) ?? new Date().toISOString(),
      });

      setIsLoading(false);
    })();
  }, [orderId]);

  const branch = orderBranchId
    ? getBranchById(orderBranchId)
    : currentBranch;

  const handlePrint = () => {
    if (typeof window === "undefined") return;
    const card = document.getElementById("careu-document-card");
    if (!card) return;
    card.classList.add("print-this");
    document.body.classList.add("printing-receipt");
    window.print();
    card.classList.remove("print-this");
    document.body.classList.remove("printing-receipt");
  };

  const handleCopyMessage = async () => {
    if (!order) return;
    const text = buildCustomerMessage(order, branch);
    try {
      await navigator.clipboard.writeText(text);
      setToast("คัดลอกข้อความเรียบร้อย พร้อมส่งให้ลูกค้า");
    } catch {
      setToast("ไม่สามารถคัดลอกได้ — โปรดลองอีกครั้ง");
    }
    setTimeout(() => setToast(null), 3500);
  };

  const handleSendLine = async () => {
    if (!order) return;
    const text = buildCustomerMessage(order, branch);
    const res = await sendToLineOA(order.id, text);
    setToast(
      res.ok ? "ส่งเข้า LINE OA สำเร็จ" : res.reason ?? "ส่งไม่สำเร็จ"
    );
    setTimeout(() => setToast(null), 4500);
  };

  const handleSaveImage = () => {
    setToast(
      "ฟังก์ชันบันทึกเป็นรูปภาพกำลังพัฒนา — ระหว่างนี้ใช้ปุ่มพิมพ์แล้วเลือก Save as PDF/Image ได้"
    );
    setTimeout(() => setToast(null), 4000);
  };

  const handlePaymentChange = async (next: string) => {
    if (!order) return;
    setPaymentSaving(true);
    const previous = order.payment_status;
    setOrder({ ...order, payment_status: next });
    const { error } = await supabase
      .from("orders")
      .update({ payment_status: next })
      .eq("id", order.id);
    if (error) {
      setOrder({ ...order, payment_status: previous });
      setToast(
        /column .* does not exist|schema cache/i.test(error.message)
          ? "ต้องรันไฟล์ supabase/migrations/20260515_payment_columns.sql ก่อน"
          : error.message
      );
      setTimeout(() => setToast(null), 5000);
    } else {
      setToast("บันทึกสถานะการชำระเรียบร้อย");
      setTimeout(() => setToast(null), 2500);
    }
    setPaymentSaving(false);
  };

  if (isLoading) {
    return (
      <div className="p-8 text-center text-gray-500">กำลังโหลดเอกสาร...</div>
    );
  }

  if (errorMessage || !order) {
    return (
      <div className="p-8">
        <div className="max-w-md mx-auto rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage ?? "ไม่พบใบงาน"}
        </div>
      </div>
    );
  }

  const subtotal =
    order.subtotal !== null
      ? order.subtotal
      : Math.max(0, order.price + order.discount - order.urgent_fee);

  const categoryLabel = categoryLabelFor(order);
  const serviceLabel = serviceLabelFor(order);
  const promotionLabel = promotionLabelFor(order);
  const customerTypeLabel = getCustomerTypeByCode(order.customer_type ?? undefined)?.nameTh ?? null;
  const paymentStatus = order.payment_status ?? "unpaid";

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="max-w-3xl mx-auto">
        {/* Action bar — hidden from print */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4 print:hidden">
          <Link
            href="/orders"
            className="text-sm text-green-700 hover:text-green-800 font-medium"
          >
            ← กลับไปคำสั่งซ่อม
          </Link>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handlePrint}
              className="px-3 py-2 rounded-lg bg-green-700 hover:bg-green-800 text-white text-sm font-medium"
            >
              พิมพ์เอกสาร
            </button>
            <button
              onClick={handleSaveImage}
              className="px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium"
            >
              บันทึกเป็นรูปภาพ
            </button>
            <button
              onClick={() => void handleSendLine()}
              className="px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium"
            >
              ส่ง Line OA
            </button>
            <button
              onClick={() => void handleCopyMessage()}
              className="px-3 py-2 rounded-lg border border-green-600 text-green-700 hover:bg-green-50 text-sm font-medium"
            >
              คัดลอกข้อความส่งลูกค้า
            </button>
          </div>
        </div>

        {toast && (
          <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800 print:hidden">
            {toast}
          </div>
        )}

        {/* Document card */}
        <div
          id="careu-document-card"
          data-receipt-id={order.id}
          className="bg-white rounded-2xl shadow-md border border-green-100 overflow-hidden"
        >
          {/* Brand header */}
          <div
            className={`bg-gradient-to-r ${branch.accentClass} px-6 py-5 border-b-4 border-yellow-400 text-white`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <BrandLogo size="lg" variant="onColor" />
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-widest text-yellow-200/90 font-semibold">
                    CareU OPS • {branch.shortLabel}
                  </p>
                  <p className="text-lg font-bold leading-tight truncate">
                    {branch.receiptName}
                  </p>
                  <p className="text-[11px] text-white/80 truncate">
                    {branch.address}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-widest opacity-90">
                  ใบรับงาน / ใบเสนอราคา
                </p>
                <p className="font-mono text-sm">
                  #{order.id.slice(0, 8).toUpperCase()}
                </p>
                <p className="text-[11px] text-white/80 mt-0.5">
                  {new Date(order.created_at).toLocaleString("th-TH", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              </div>
            </div>
          </div>

          {/* Customer */}
          <section className="px-6 pt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-gray-500">
                ลูกค้า
              </p>
              <p className="text-base font-semibold text-gray-800">
                {order.customer_name || "-"}
              </p>
              <p className="text-sm text-gray-600">
                {order.customer_phone || "-"}
              </p>
              {customerTypeLabel && (
                <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-800 text-[11px] font-medium">
                  {customerTypeLabel}
                </span>
              )}
            </div>
            <div className="sm:text-right">
              <p className="text-[10px] uppercase tracking-widest text-gray-500">
                สถานะงาน
              </p>
              <span
                className={`inline-block mt-1 px-3 py-1 rounded-full text-xs font-medium border ${
                  statusBadgeClasses[order.status] ??
                  "bg-gray-100 text-gray-700 border-gray-300"
                }`}
              >
                {statusLabelTh[order.status] ?? order.status}
              </span>
            </div>
          </section>

          {/* Service */}
          <section className="px-6 mt-5">
            <p className="text-[10px] uppercase tracking-widest text-gray-500">
              บริการ
            </p>
            {categoryLabel && (
              <p className="text-[11px] text-green-700 font-semibold mt-0.5">
                {categoryLabel}
              </p>
            )}
            <p className="text-lg font-semibold text-gray-800 mt-0.5 break-words">
              {serviceLabel}
              {order.quantity > 1 && (
                <span className="ml-2 text-sm text-gray-500">
                  × {order.quantity}
                </span>
              )}
            </p>
            {order.template_text && (
              <p className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">
                {order.template_text}
              </p>
            )}
            {order.notes && (
              <div className="mt-3 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
                <p className="text-[11px] uppercase tracking-widest text-gray-500">
                  บันทึก
                </p>
                <p className="text-sm text-gray-800 whitespace-pre-wrap">
                  {order.notes}
                </p>
              </div>
            )}
            <div className="mt-3 rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
              ภาพ/วิดีโอ/เอกสารแนบจะปรากฏที่นี่เมื่อระบบ Storage พร้อมใช้งาน
            </div>
          </section>

          {/* Price */}
          <section className="px-6 mt-5 pt-4 border-t border-gray-200">
            <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">
              สรุปยอด
            </p>
            <div className="text-sm space-y-1.5">
              <div className="flex justify-between">
                <span className="text-gray-600">
                  ยอดก่อนส่วนลด ({order.quantity} ×{" "}
                  {formatCurrency(
                    subtotal > 0 ? Math.round(subtotal / order.quantity) : 0
                  )}
                  )
                </span>
                <span className="text-gray-800">{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">ค่างานด่วน</span>
                <span className="text-gray-800">
                  {formatCurrency(order.urgent_fee)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">
                  ส่วนลด{promotionLabel ? ` (${promotionLabel})` : ""}
                </span>
                <span className="text-gray-800">
                  -{formatCurrency(order.discount)}
                </span>
              </div>
              <div className="flex justify-between items-center pt-2 border-t border-gray-200">
                <span className="text-gray-700 font-medium">ยอดรวมสุทธิ</span>
                <span className="text-2xl font-bold text-green-700">
                  {formatCurrency(order.price)}
                </span>
              </div>
            </div>
          </section>

          {/* Payment */}
          <section className="px-6 mt-5 pt-4 border-t border-gray-200">
            <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">
              ช่องชำระเงิน
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg border border-dashed border-yellow-300 bg-yellow-50/40 p-3 flex items-center gap-3">
                <div className="w-24 h-24 flex-shrink-0 grid place-items-center bg-white border border-yellow-300 rounded-md text-[10px] text-gray-400 text-center leading-tight">
                  QR
                  <br />
                  Code
                </div>
                <div className="text-xs text-gray-600">
                  <p className="font-medium text-gray-700">ชำระผ่าน QR</p>
                  <p>สแกนเพื่อชำระ — รูป QR จะอัปโหลดต่อสาขาในเฟสถัดไป</p>
                </div>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-700">
                <p className="font-medium text-gray-800">โอนผ่านบัญชีธนาคาร</p>
                <p className="mt-1 text-gray-500">
                  เลขที่บัญชี: <span className="text-gray-700">ระบุภายหลัง</span>
                </p>
                <p className="text-gray-500">
                  ชื่อบัญชี: <span className="text-gray-700">{branch.receiptName}</span>
                </p>
                <p className="text-gray-500">
                  สาขา: <span className="text-gray-700">{branch.shortLabel}</span>
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-gray-500">
                  สถานะการชำระ
                </p>
                <span
                  className={`inline-block mt-1 px-3 py-1 rounded-full text-xs font-medium border ${
                    paymentBadgeClasses[paymentStatus] ??
                    "bg-gray-100 text-gray-700 border-gray-300"
                  }`}
                >
                  {formatPaymentStatus(paymentStatus)}
                </span>
              </div>
              <div className="flex items-center gap-2 print:hidden">
                <label className="text-xs text-gray-500">เปลี่ยนสถานะ</label>
                <select
                  value={paymentStatus}
                  onChange={(e) => void handlePaymentChange(e.target.value)}
                  disabled={paymentSaving}
                  className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm"
                >
                  {PAYMENT_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-sm text-gray-700">
                ยอดที่ต้องชำระ:{" "}
                <span className="font-bold text-green-700">
                  {formatCurrency(
                    paymentStatus === "paid" ? 0 : order.price
                  )}
                </span>
              </p>
            </div>
          </section>

          {/* Next steps */}
          <section className="px-6 mt-5 pt-4 border-t border-gray-200">
            <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">
              ขั้นตอนถัดไป
            </p>
            <ol className="text-sm text-gray-700 list-decimal pl-5 space-y-1">
              <li>ยืนยันราคาและชำระเงิน</li>
              <li>ร้านรับงานเข้าระบบ</li>
              <li>แจ้งเมื่องานเสร็จ</li>
              <li>รับงานตามกำหนด</li>
            </ol>
          </section>

          {/* Footer */}
          <footer className="mt-6 bg-yellow-50 border-t border-yellow-200 px-6 py-4 text-center">
            <p className="text-sm font-medium text-gray-700">
              {branch.receiptName} • {branch.shortLabel}
            </p>
            <p className="text-xs text-gray-600">{branch.address}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              เปิดบริการ จันทร์–เสาร์ 09:00–18:00 (เวลาทำการอาจปรับตามสาขา)
            </p>
            <p className="text-xs text-green-700 mt-1 italic">
              {branch.tagline}
            </p>
            <p className="text-[11px] text-gray-500 mt-2">
              รับประกันงานซ่อม 7 วัน นับจากวันรับของกลับ
              (ไม่ครอบคลุมความเสียหายจากการใช้งาน)
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}
