"use client";

import { useEffect, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useBranch } from "@/lib/branchContext";
import { BrandLogo } from "@/components/BrandLogo";

type InvoiceRow = {
  id: string;
  customer_name: string;
  item_name: string;
  price: number;
  status: string;
  created_at: string;
};

// Charge breakdown is built from the order row. Until the schema adds
// discount / urgent_fee columns, these helpers return 0 — the receipt
// layout already has slots ready so we won't need a template change later.
function getDiscount(_inv: InvoiceRow): number {
  return 0;
}

function getUrgentFee(_inv: InvoiceRow): number {
  return 0;
}

function getSubtotal(inv: InvoiceRow): number {
  return inv.price;
}

function getTotal(inv: InvoiceRow): number {
  return getSubtotal(inv) - getDiscount(inv) + getUrgentFee(inv);
}

const statusLabelsTh: Record<string, string> = {
  pending: "รอดำเนิน",
  "in-progress": "กำลังซ่อม",
  completed: "เสร็จสิ้น",
  "ready-for-pickup": "พร้อมรับ",
};

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 border-yellow-300",
  "in-progress": "bg-blue-100 text-blue-800 border-blue-300",
  completed: "bg-green-100 text-green-800 border-green-300",
  "ready-for-pickup": "bg-purple-100 text-purple-800 border-purple-300",
};

export default function InvoicesPage() {
  const { branch } = useBranch();
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
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
        setInvoices([]);
      } else {
        setInvoices(
          (data ?? []).map((row) => ({
            id: String(row.id),
            customer_name: row.customer_name ?? "",
            item_name: row.item_name ?? "",
            price: Number(row.price ?? 0),
            status: row.status ?? "",
            created_at: row.created_at,
          }))
        );
      }
      setIsLoading(false);
    })();
  }, []);

  const handlePrint = (id: string) => {
    const card = document.querySelector(`[data-receipt-id="${id}"]`);
    if (!card) return;
    card.classList.add("print-this");
    document.body.classList.add("printing-receipt");
    window.print();
    card.classList.remove("print-this");
    document.body.classList.remove("printing-receipt");
  };

  return (
    <div className="flex-1 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-6 border-l-4 border-yellow-400 pl-4">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
          {branch.receiptName}
        </p>
        <h1 className="text-3xl md:text-4xl font-bold text-gray-800">ใบเสร็จ</h1>
      </div>

      {errorMessage && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {isLoading ? (
        <div className="bg-white rounded-xl border p-8 text-center text-gray-500">
          กำลังโหลด...
        </div>
      ) : invoices.length === 0 ? (
        <div className="bg-white rounded-xl border p-8 text-center text-gray-500">
          ไม่มีใบเสร็จ
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {invoices.map((inv) => (
            <div
              key={inv.id}
              data-receipt-id={inv.id}
              className="bg-white rounded-2xl shadow-md border border-green-100 overflow-hidden"
            >
              {/* Brand header (accent gradient driven by branch) */}
              <div
                className={`bg-gradient-to-r ${branch.accentClass} px-6 py-4 flex items-center justify-between border-b-4 border-yellow-400 text-white`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <BrandLogo size="md" variant="onColor" />
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-widest text-yellow-200/90 font-semibold">
                      CareU OPS
                    </p>
                    <p className="text-base font-bold leading-tight truncate">
                      {branch.receiptName}
                    </p>
                    <p className="text-[11px] text-white/80 truncate">
                      {branch.address}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-widest opacity-90">
                    Receipt
                  </div>
                  <div className="font-mono text-sm">
                    #{inv.id.slice(0, 8).toUpperCase()}
                  </div>
                </div>
              </div>

              {/* Receipt body */}
              <div className="px-6 py-5 space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">ลูกค้า</span>
                  <span className="font-medium text-gray-800">
                    {inv.customer_name || "-"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">วันที่</span>
                  <span className="text-gray-800">
                    {new Date(inv.created_at).toLocaleDateString("th-TH", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </div>

                <div className="border-t border-dashed border-gray-200 my-3" />

                <div className="flex justify-between">
                  <span className="text-gray-500">รายการ</span>
                  <span className="text-gray-800">
                    {inv.item_name || "-"}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">สถานะ</span>
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${
                      statusColors[inv.status] ??
                      "bg-gray-100 text-gray-700 border-gray-300"
                    }`}
                  >
                    {statusLabelsTh[inv.status] ?? inv.status}
                  </span>
                </div>

                <div className="border-t border-gray-200 my-3" />

                {/* Charge breakdown */}
                <div className="flex justify-between">
                  <span className="text-gray-500">ยอดก่อนส่วนลด</span>
                  <span className="text-gray-800">
                    {formatCurrency(getSubtotal(inv))}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">ส่วนลด</span>
                  <span className="text-gray-800">
                    -{formatCurrency(getDiscount(inv))}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">ค่างานด่วน</span>
                  <span className="text-gray-800">
                    {formatCurrency(getUrgentFee(inv))}
                  </span>
                </div>

                <div className="border-t border-gray-200 my-3" />

                <div className="flex justify-between items-center">
                  <span className="text-gray-600 font-medium">ยอดรวมสุทธิ</span>
                  <span className="text-2xl font-bold text-green-700">
                    {formatCurrency(getTotal(inv))}
                  </span>
                </div>

                {/* QR payment placeholder (drop a QR <img> here later) */}
                <div className="mt-4 flex items-center gap-4 border border-dashed border-yellow-300 bg-yellow-50/40 rounded-lg p-3">
                  <div className="w-20 h-20 flex-shrink-0 grid place-items-center bg-white border border-yellow-300 rounded-md text-[10px] text-gray-400 text-center leading-tight">
                    QR
                    <br />
                    Code
                  </div>
                  <div className="text-xs text-gray-600">
                    <p className="font-medium text-gray-700">ชำระผ่าน QR</p>
                    <p>สแกนเพื่อชำระ — รายละเอียดการชำระจะแสดงในเฟสถัดไป</p>
                  </div>
                </div>
              </div>

              {/* Thank-you footer */}
              <div className="bg-yellow-50 border-t border-yellow-200 px-6 py-4 text-center">
                <p className="text-sm font-medium text-gray-700">
                  ขอบคุณที่ใช้บริการ {branch.receiptName}
                </p>
                <p className="text-xs text-green-700 mt-1 italic">
                  {branch.tagline}
                </p>
              </div>

              {/* Actions (excluded from print) */}
              <div className="px-6 py-3 bg-white border-t border-gray-100 flex justify-end print:hidden">
                <button
                  onClick={() => handlePrint(inv.id)}
                  className="bg-green-600 hover:bg-green-700 text-white text-sm px-4 py-2 rounded-lg font-medium transition"
                >
                  พิมพ์ใบเสร็จ
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
