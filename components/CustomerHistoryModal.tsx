"use client";

import { useEffect, useMemo, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";

type HistoryOrder = {
  id: string;
  item_name: string;
  price: number;
  status: string;
  created_at: string;
};

interface CustomerHistoryModalProps {
  isOpen: boolean;
  customerId: string | null;
  customerName: string;
  customerPhone?: string;
  onClose: () => void;
}

const statusBadge: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  "in-progress": "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  "ready-for-pickup": "bg-purple-100 text-purple-800",
};

const statusLabelTh: Record<string, string> = {
  pending: "รอดำเนิน",
  "in-progress": "กำลังซ่อม",
  completed: "เสร็จสิ้น",
  "ready-for-pickup": "พร้อมรับ",
};

export function CustomerHistoryModal({
  isOpen,
  customerId,
  customerName,
  customerPhone,
  onClose,
}: CustomerHistoryModalProps) {
  const [orders, setOrders] = useState<HistoryOrder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !customerId) return;

    void (async () => {
      setIsLoading(true);
      setErrorMessage(null);

      const { data, error } = await supabase
        .from("orders")
        .select("id, item_name, price, status, created_at")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false });

      if (error) {
        setErrorMessage(error.message);
        setOrders([]);
      } else {
        setOrders(
          (data ?? []).map((r) => ({
            id: String(r.id),
            item_name: r.item_name ?? "",
            price: Number(r.price ?? 0),
            status: r.status ?? "",
            created_at: r.created_at,
          }))
        );
      }
      setIsLoading(false);
    })();
  }, [isOpen, customerId]);

  const summary = useMemo(() => {
    const totalOrders = orders.length;
    const totalSpent = orders.reduce((s, o) => s + o.price, 0);
    const latestDate = orders[0]?.created_at ?? null;
    return { totalOrders, totalSpent, latestDate };
  }, [orders]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto border border-green-100">
        {/* Header */}
        <div className="bg-gradient-to-r from-green-700 to-green-600 px-6 py-4 flex items-center justify-between border-b-4 border-yellow-400 rounded-t-2xl">
          <div className="text-white min-w-0">
            <p className="text-[11px] uppercase tracking-widest text-yellow-200 font-semibold">
              ประวัติลูกค้า
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold truncate">
                {customerName || "-"}
              </h2>
              {summary.totalOrders >= 2 && (
                <span className="px-2 py-0.5 rounded-full bg-yellow-300 text-green-900 text-[10px] font-bold uppercase tracking-wide">
                  ลูกค้าประจำ
                </span>
              )}
              {summary.totalOrders === 0 && (
                <span className="px-2 py-0.5 rounded-full bg-white/20 text-white text-[10px] font-bold uppercase tracking-wide">
                  ลูกค้าใหม่
                </span>
              )}
            </div>
            {customerPhone && (
              <p className="text-sm text-green-100">{customerPhone}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-white/90 hover:text-white text-2xl leading-none"
            aria-label="close"
          >
            ✕
          </button>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4 md:p-6 bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40">
          <div className="border border-green-100 bg-white rounded-xl p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              คำสั่งซ่อมทั้งหมด
            </p>
            <p className="text-2xl font-bold text-gray-800 mt-1">
              {summary.totalOrders}
            </p>
          </div>
          <div className="border border-green-100 bg-white rounded-xl p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              ยอดใช้จ่ายรวม
            </p>
            <p className="text-2xl font-bold text-green-700 mt-1">
              {formatCurrency(summary.totalSpent)}
            </p>
          </div>
          <div className="border border-green-100 bg-white rounded-xl p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              คำสั่งซ่อมล่าสุด
            </p>
            <p className="text-base font-semibold text-gray-800 mt-2">
              {summary.latestDate
                ? new Date(summary.latestDate).toLocaleDateString("th-TH", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })
                : "-"}
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 md:px-6 pb-6">
          {errorMessage && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {errorMessage}
            </div>
          )}

          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-3 text-xs text-gray-500 mb-4">
            ภาพ/วิดีโอ/เอกสารของลูกค้าจะแสดงที่นี่เมื่อระบบ Storage พร้อมใช้งาน
          </div>

          {isLoading ? (
            <div className="p-8 text-center text-gray-500">กำลังโหลด...</div>
          ) : orders.length === 0 ? (
            <div className="p-8 text-center text-gray-500 bg-white rounded-xl border border-gray-200">
              ยังไม่มีคำสั่งซ่อม
            </div>
          ) : (
            <div className="overflow-x-auto bg-white rounded-xl border border-gray-200">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">
                      วันที่
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">
                      รายการ
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">
                      สถานะ
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-700">
                      ราคา
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} className="border-b border-gray-100">
                      <td className="px-4 py-3 text-sm text-gray-700">
                        {new Date(o.created_at).toLocaleDateString("th-TH")}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-800">
                        {o.item_name || "-"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            statusBadge[o.status] ?? "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {statusLabelTh[o.status] ?? o.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-semibold text-green-700">
                        {formatCurrency(o.price)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CustomerHistoryModal;
