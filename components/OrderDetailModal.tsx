"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { getBranchById } from "@/lib/brandConfig";
import {
  getCategoryByCode,
  getCustomerTypeByCode,
  getPromotionByCode,
  getServiceByCode,
} from "@/lib/pricing";
import {
  fetchOrderItems,
  updateOrderItemStatus,
  type OrderItemRow,
} from "@/lib/orderItems";
import { ORDER_OPS_FLOW, orderStatusLabel } from "@/lib/statusBadges";
import { OrderStatusBadge } from "@/components/StatusBadge";

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
  const [subtotal, setSubtotal] = useState<number | null>(null);
  const [discount, setDiscount] = useState<number>(0);
  const [laborCost, setLaborCost] = useState<number | null>(null);
  const [materialCost, setMaterialCost] = useState<number | null>(null);
  const [serviceCategory, setServiceCategory] = useState<string | null>(null);
  const [serviceCode, setServiceCode] = useState<string | null>(null);
  const [serviceName, setServiceName] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number>(1);
  const [templateText, setTemplateText] = useState<string | null>(null);
  const [customerType, setCustomerType] = useState<string | null>(null);
  const [promotionCode, setPromotionCode] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[] | null>(null);
  const [items, setItems] = useState<OrderItemRow[]>([]);
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
      setSubtotal(null);
      setDiscount(0);
      setLaborCost(null);
      setMaterialCost(null);
      setServiceCategory(null);
      setServiceCode(null);
      setServiceName(null);
      setQuantity(1);
      setTemplateText(null);
      setCustomerType(null);
      setPromotionCode(null);
      setAttachments(null);
      setItems([]);

      // Try the smart-order extended columns. If any are missing (migration not
      // yet applied), narrow the projection and retry so older databases work.
      type ExtendedRow = {
        notes?: string | null;
        urgent?: boolean | null;
        urgent_fee?: number | string | null;
        branch_id?: string | null;
        subtotal?: number | string | null;
        discount?: number | string | null;
        service_category?: string | null;
        service_code?: string | null;
        service_name?: string | null;
        quantity?: number | null;
        template_text?: string | null;
        customer_type?: string | null;
        promotion_code?: string | null;
        labor_cost?: number | string | null;
        material_cost?: number | string | null;
      };
      let extendedRow: ExtendedRow | null = null;
      const wide = await supabase
        .from("orders")
        .select(
          "notes, urgent, urgent_fee, branch_id, subtotal, discount, service_category, service_code, service_name, quantity, template_text, customer_type, promotion_code, labor_cost, material_cost"
        )
        .eq("id", order.id)
        .maybeSingle();
      if (!wide.error && wide.data) {
        extendedRow = wide.data as ExtendedRow;
      } else {
        const narrow = await supabase
          .from("orders")
          .select("notes, urgent, urgent_fee, branch_id")
          .eq("id", order.id)
          .maybeSingle();
        if (!narrow.error && narrow.data) {
          extendedRow = narrow.data as ExtendedRow;
        }
      }
      if (extendedRow) {
        setNotes(extendedRow.notes ?? null);
        setUrgent(Boolean(extendedRow.urgent));
        setUrgentFee(Number(extendedRow.urgent_fee ?? 0));
        setBranchId(extendedRow.branch_id ?? null);
        setSubtotal(
          extendedRow.subtotal !== null && extendedRow.subtotal !== undefined
            ? Number(extendedRow.subtotal)
            : null
        );
        setDiscount(Number(extendedRow.discount ?? 0));
        setServiceCategory(extendedRow.service_category ?? null);
        setServiceCode(extendedRow.service_code ?? null);
        setServiceName(extendedRow.service_name ?? null);
        setQuantity(Number(extendedRow.quantity ?? 1));
        setTemplateText(extendedRow.template_text ?? null);
        setCustomerType(extendedRow.customer_type ?? null);
        setPromotionCode(extendedRow.promotion_code ?? null);
        setLaborCost(
          extendedRow.labor_cost !== null && extendedRow.labor_cost !== undefined
            ? Number(extendedRow.labor_cost)
            : null
        );
        setMaterialCost(
          extendedRow.material_cost !== null && extendedRow.material_cost !== undefined
            ? Number(extendedRow.material_cost)
            : null
        );
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

      // Per-item rows (multi-item tickets). Empty for legacy orders.
      setItems(await fetchOrderItems(supabase, order.id));

      setIsLoading(false);
    })();
  }, [order]);

  const handleItemStatus = async (itemId: string, status: string) => {
    setErrorMessage(null);
    const prev = items;
    setItems((curr) =>
      curr.map((it) => (it.id === itemId ? { ...it, status } : it))
    );
    const res = await updateOrderItemStatus(itemId, status);
    if (res.error) {
      setErrorMessage(res.error);
      setItems(prev);
    }
  };

  if (!order) return null;

  const branchLabel = branchId ? getBranchById(branchId).shortLabel : "-";
  const displaySubtotal =
    subtotal !== null
      ? subtotal
      : Math.max(0, order.price + discount - (urgent ? urgentFee : 0));
  const serviceLabel =
    serviceName ||
    getServiceByCode(serviceCode ?? undefined)?.nameTh ||
    order.item_name ||
    "-";
  const categoryLabel =
    getCategoryByCode(serviceCategory ?? undefined)?.labelTh ?? null;
  const promotionLabel =
    promotionCode && promotionCode !== "NONE"
      ? getPromotionByCode(promotionCode)?.nameTh ?? promotionCode
      : null;
  const customerTypeLabel =
    getCustomerTypeByCode(customerType ?? undefined)?.nameTh ?? null;
  const hasCostData = laborCost !== null || materialCost !== null;
  const jobProfit = hasCostData
    ? order.price - (laborCost ?? 0) - (materialCost ?? 0)
    : null;
  const jobMargin =
    hasCostData && order.price > 0 && jobProfit !== null
      ? Math.round((jobProfit / order.price) * 100)
      : null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto border border-green-100">
        {/* Header */}
        <div className="bg-gradient-to-r from-green-700 to-green-600 px-6 py-4 flex items-center justify-between gap-3 border-b-4 border-yellow-400 rounded-t-2xl">
          <div className="text-white min-w-0">
            <p className="text-[11px] uppercase tracking-widest text-yellow-200 font-semibold">
              ใบงานซ่อม
            </p>
            <p className="font-mono text-sm">
              #{order.id.slice(0, 8).toUpperCase()}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/orders/${order.id}/document`}
              onClick={onClose}
              className="text-xs font-medium bg-white/15 hover:bg-white/25 text-white px-3 py-1.5 rounded-lg"
            >
              ดูเอกสารฉบับเต็ม
            </Link>
            <button
              onClick={onClose}
              className="text-white/90 hover:text-white text-2xl leading-none"
              aria-label="close"
            >
              ✕
            </button>
          </div>
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
              {customerTypeLabel && (
                <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-800 text-[11px] font-medium">
                  {customerTypeLabel}
                </span>
              )}
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
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  บริการ
                </p>
                {categoryLabel && (
                  <p className="text-[11px] text-green-700 font-semibold mt-0.5">
                    {categoryLabel}
                  </p>
                )}
                <p className="font-semibold text-gray-800 mt-1 break-words">
                  {serviceLabel}
                  {quantity > 1 && (
                    <span className="ml-1 text-sm text-gray-500">
                      × {quantity}
                    </span>
                  )}
                </p>
                {templateText && (
                  <p className="text-xs text-gray-600 mt-2 whitespace-pre-wrap">
                    {templateText}
                  </p>
                )}
              </div>
              <span
                className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap ${
                  statusBadge[order.status] ?? "bg-gray-100 text-gray-700"
                }`}
              >
                {statusLabelTh[order.status] ?? order.status}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 text-sm">
              <div>
                <p className="text-xs text-gray-500">ยอดก่อนส่วนลด</p>
                <p className="font-semibold text-gray-800">
                  {formatCurrency(displaySubtotal)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">ค่างานด่วน</p>
                <p className="font-semibold text-gray-800">
                  {formatCurrency(urgent ? urgentFee : 0)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">
                  ส่วนลด{promotionLabel ? ` (${promotionLabel})` : ""}
                </p>
                <p className="font-semibold text-gray-800">
                  -{formatCurrency(discount)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">ยอดรวมสุทธิ</p>
                <p className="font-bold text-green-700">
                  {formatCurrency(order.price)}
                </p>
              </div>
            </div>

            {hasCostData && (
              <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-2">
                  ต้นทุน / กำไรงานนี้ (ภายใน)
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-gray-500">ค่าแรง</p>
                    <p className="font-semibold text-gray-800">
                      {formatCurrency(laborCost ?? 0)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">ค่าวัสดุ</p>
                    <p className="font-semibold text-gray-800">
                      {formatCurrency(materialCost ?? 0)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">กำไรงาน</p>
                    <p
                      className={`font-bold ${
                        (jobProfit ?? 0) >= 0 ? "text-green-700" : "text-red-700"
                      }`}
                    >
                      {formatCurrency(jobProfit ?? 0)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">อัตรากำไร</p>
                    <p
                      className={`font-bold ${
                        (jobMargin ?? 0) >= 0 ? "text-green-700" : "text-red-700"
                      }`}
                    >
                      {jobMargin !== null ? `${jobMargin}%` : "-"}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Per-item workflow — multi-item tickets only */}
          {items.length > 0 && (
            <div className="border border-gray-200 rounded-xl p-4">
              <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                รายการในใบงาน ({items.length})
              </p>
              <div className="space-y-2">
                {items.map((it) => (
                  <div
                    key={it.id}
                    className="rounded-lg border border-gray-100 bg-gray-50/60 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900">
                          {it.line_no}. {it.service_name}
                          {Number(it.quantity) > 1 && (
                            <span className="ml-1 text-xs text-gray-500">
                              × {it.quantity}
                            </span>
                          )}
                          {it.urgent && (
                            <span className="ml-1.5 rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
                              ⚡ ด่วน
                            </span>
                          )}
                        </p>
                        {it.detail && (
                          <p className="mt-0.5 whitespace-pre-wrap text-xs text-gray-600">
                            {it.detail}
                          </p>
                        )}
                        <p className="mt-0.5 text-xs text-gray-500">
                          {formatCurrency(Number(it.line_total))}
                          {it.due_date ? ` · กำหนด ${it.due_date}` : ""}
                        </p>
                        {it.technician_note && (
                          <p className="mt-0.5 text-[11px] text-gray-500">
                            ช่าง: {it.technician_note}
                          </p>
                        )}
                        {it.customer_note && (
                          <p className="text-[11px] text-gray-500">
                            ลูกค้า: {it.customer_note}
                          </p>
                        )}
                      </div>
                      <OrderStatusBadge status={it.status} size="sm" />
                    </div>
                    <select
                      value={it.status}
                      onChange={(e) =>
                        void handleItemStatus(it.id, e.target.value)
                      }
                      aria-label="สถานะรายการ"
                      className="mt-2 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
                    >
                      {ORDER_OPS_FLOW.map((s) => (
                        <option key={s} value={s}>
                          {orderStatusLabel(s)}
                        </option>
                      ))}
                      {!(ORDER_OPS_FLOW as readonly string[]).includes(
                        it.status
                      ) && (
                        <option value={it.status}>
                          {orderStatusLabel(it.status)}
                        </option>
                      )}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

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
