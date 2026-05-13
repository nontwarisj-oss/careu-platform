"use client";

import { useEffect, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { getBranchById } from "@/lib/brandConfig";

export type OrderDetailInput = {
  id: string;
  customer_id: string | null;
  customer_name: string;
  item_name: string;
  price: number;
  status: string;
  created_at: string;
};

type Attachment = {
  id: string;
  file_url: string;
  file_type: string;
  file_name: string | null;
};

interface OrderDetailModalProps {
  order: OrderDetailInput | null;
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

export function OrderDetailModal({ order, onClose }: OrderDetailModalProps) {
  const [customerPhone, setCustomerPhone] = useState<string>("");
  const [notes, setNotes] = useState<string | null>(null);
  const [urgent, setUrgent] = useState<boolean>(false);
  const [urgentFee, setUrgentFee] = useState<number>(0);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!order) return;

    void (async () => {
      setIsLoading(true);
      setErrorMessage(null);
      setCustomerPhone("");
      setNotes(null);
      setUrgent(false);
      setUrgentFee(0);
      setBranchId(null);
      setAttachments(null);

      // Try the extended order columns. If they don't exist yet (migration
      // not applied), silently fall back to the legacy projection.
      const extended = await supabase
        .from("orders")
        .select("notes, urgent, urgent_fee, branch_id")
        .eq("id", order.id)
        .maybeSingle();
      if (!extended.error && extended.data) {
        const row = extended.data as {
          notes?: string | null;
          urgent?: boolean | null;
          urgent_fee?: number | string | null;
          branch_id?: string | null;
        };
        setNotes(row.notes ?? null);
        setUrgent(Boolean(row.urgent));
        setUrgentFee(Number(row.urgent_fee ?? 0));
        setBranchId(row.branch_id ?? null);
      }

      // Customer phone — only resolvable when customer_id is present.
      if (order.customer_id) {
        const { data: customer } = await supabase
          .from("customers")
          .select("phone")
          .eq("id", order.customer_id)
          .maybeSingle();
        if (customer?.phone) {
          setCustomerPhone(customer.phone as string);
        }
      }

      // Attachments table is optional — if the migration hasn't been run,
      // the request errors and we treat that as "no media yet".
      const { data: media, error: mediaError } = await supabase
        .from("order_attachments")
        .select("id, file_url, file_type, file_name")
        .eq("order_id", order.id)
        .order("created_at", { ascending: true });
      if (mediaError) {
        setAttachments([]);
      } else {
        setAttachments((media ?? []) as Attachment[]);
      }

      setIsLoading(false);
    })();
  }, [order]);

  if (!order) return null;

  const branchLabel = branchId ? getBranchById(branchId).shortLabel : "-";
  const subtotal = order.price - (urgent ? urgentFee : 0);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto border border-green-100">
        {/* Header */}
        <div className="bg-gradient-to-r from-green-700 to-green-600 px-6 py-4 flex items-center justify-between border-b-4 border-yellow-400 rounded-t-2xl">
          <div className="text-white min-w-0">
            <p className="text-[11px] uppercase tracking-widest text-yellow-200 font-semibold">
              ใบงานซ่อม
            </p>
            <p className="font-mono text-sm">
              #{order.id.slice(0, 8).toUpperCase()}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-white/90 hover:text-white text-2xl leading-none"
            aria-label="close"
          >
            ✕
          </button>
        </div>

        <div className="p-4 md:p-6 space-y-5">
          {errorMessage && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {errorMessage}
            </div>
          )}

          {/* Customer + branch */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="border border-gray-200 rounded-xl p-4">
              <p className="text-xs uppercase tracking-wide text-gray-500">ลูกค้า</p>
              <p className="font-semibold text-gray-800 mt-1">
                {order.customer_name || "-"}
              </p>
              <p className="text-sm text-gray-600">{customerPhone || "-"}</p>
            </div>
            <div className="border border-gray-200 rounded-xl p-4">
              <p className="text-xs uppercase tracking-wide text-gray-500">สาขา</p>
              <p className="font-semibold text-gray-800 mt-1">{branchLabel}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {new Date(order.created_at).toLocaleString("th-TH")}
              </p>
            </div>
          </div>

          {/* Job */}
          <div className="border border-gray-200 rounded-xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wide text-gray-500">รายการ</p>
                <p className="font-semibold text-gray-800 mt-1 break-words">
                  {order.item_name || "-"}
                </p>
              </div>
              <span
                className={`px-3 py-1 rounded-full text-xs font-medium ${
                  statusBadge[order.status] ?? "bg-gray-100 text-gray-700"
                }`}
              >
                {statusLabelTh[order.status] ?? order.status}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-3 mt-4">
              <div>
                <p className="text-xs text-gray-500">ราคา</p>
                <p className="font-semibold text-gray-800">
                  {formatCurrency(subtotal)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">ค่างานด่วน</p>
                <p className="font-semibold text-gray-800">
                  {urgent ? formatCurrency(urgentFee) : formatCurrency(0)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">รวม</p>
                <p className="font-bold text-green-700">
                  {formatCurrency(order.price)}
                </p>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="border border-gray-200 rounded-xl p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
              บันทึก
            </p>
            <p className="text-sm text-gray-800 whitespace-pre-wrap">
              {notes && notes.trim() ? notes : "—"}
            </p>
          </div>

          {/* Media */}
          <div className="border border-gray-200 rounded-xl p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">
              ภาพ / วิดีโอ / เอกสารรับงาน
            </p>
            {isLoading ? (
              <p className="text-sm text-gray-500">กำลังโหลด...</p>
            ) : attachments && attachments.length > 0 ? (
              <ul className="space-y-2">
                {attachments.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 text-sm">
                    <span className="text-xs uppercase rounded bg-gray-100 px-2 py-0.5 text-gray-700">
                      {a.file_type.split("/")[0] || "file"}
                    </span>
                    <a
                      href={a.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-green-700 hover:text-green-800 truncate"
                    >
                      {a.file_name || a.file_url}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-500">
                ยังไม่มีรูปภาพหรือวิดีโอแนบ
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default OrderDetailModal;
