"use client";

import { useEffect, useMemo, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { getBranchById } from "@/lib/brandConfig";
import { getServiceByCode } from "@/lib/pricing";

type HistoryOrder = {
  id: string;
  item_name: string;
  service_name: string | null;
  service_code: string | null;
  price: number;
  status: string;
  created_at: string;
  branch_id: string | null;
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

      // Try the wide projection (service_name / branch_id) and fall back to
      // legacy columns if the smart-order migration hasn't been run.
      type RawRow = {
        id: string;
        item_name?: string | null;
        service_name?: string | null;
        service_code?: string | null;
        price: number | string | null;
        status?: string | null;
        created_at: string;
        branch_id?: string | null;
      };
      let rawRows: RawRow[] | null = null;
      const wide = await supabase
        .from("orders")
        .select(
          "id, item_name, service_name, service_code, price, status, created_at, branch_id"
        )
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false });
      if (!wide.error) {
        rawRows = (wide.data ?? []) as unknown as RawRow[];
      } else {
        const narrow = await supabase
          .from("orders")
          .select("id, item_name, price, status, created_at")
          .eq("customer_id", customerId)
          .order("created_at", { ascending: false });
        if (narrow.error) {
          setErrorMessage(narrow.error.message);
          setOrders([]);
          setIsLoading(false);
          return;
        }
        rawRows = (narrow.data ?? []) as unknown as RawRow[];
      }

      setOrders(
        rawRows.map((r) => ({
          id: String(r.id),
          item_name: r.item_name ?? "",
          service_name: r.service_name ?? null,
          service_code: r.service_code ?? null,
          price: Number(r.price ?? 0),
          status: r.status ?? "",
          created_at: r.created_at,
          branch_id: r.branch_id ?? null,
        }))
      );
      setIsLoading(false);
    })();
  }, [isOpen, customerId]);

  const summary = useMemo(() => {
    const totalOrders = orders.length;
    const totalSpent = orders.reduce((s, o) => s + o.price, 0);
    const latestDate = orders[0]?.created_at ?? null;
    const latest = orders[0];
    const latestService = latest
      ? latest.service_name ??
        getServiceByCode(latest.service_code ?? undefined)?.nameTh ??
        latest.item_name
      : null;
    const branchCounts = new Map<string, number>();
    for (const o of orders) {
      if (!o.branch_id) continue;
      branchCounts.set(o.branch_id, (branchCounts.get(o.branch_id) ?? 0) + 1);
    }
    const branches = Array.from(branchCounts.entries())
      .map(([id, count]) => ({ id, count, label: getBranchById(id).shortLabel }))
      .sort((a, b) => b.count - a.count);
    const segment: "vip" | "repeat" | "new" =
      totalOrders >= 5 ? "vip" : totalOrders >= 2 ? "repeat" : "new";

    const avgTicket = totalOrders > 0 ? Math.round(totalSpent / totalOrders) : 0;

    let daysSinceLast: number | null = null;
    if (latestDate) {
      const diff = Date.now() - new Date(latestDate).getTime();
      daysSinceLast = Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
    }

    // Visits per month over the customer's active window (first → most recent
    // order, minimum one month). Useful as a frequency proxy.
    let visitsPerMonth = 0;
    if (totalOrders > 1) {
      const sorted = [...orders].sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      const firstMs = new Date(sorted[0].created_at).getTime();
      const lastMs = new Date(sorted[sorted.length - 1].created_at).getTime();
      const months = Math.max(1, (lastMs - firstMs) / (1000 * 60 * 60 * 24 * 30));
      visitsPerMonth = Math.round((totalOrders / months) * 10) / 10;
    }

    return {
      totalOrders,
      totalSpent,
      latestDate,
      latestService,
      branches,
      segment,
      avgTicket,
      daysSinceLast,
      visitsPerMonth,
    };
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
              {summary.segment === "vip" && (
                <span className="px-2 py-0.5 rounded-full bg-yellow-300 text-green-900 text-[10px] font-bold uppercase tracking-wide">
                  VIP
                </span>
              )}
              {summary.segment === "repeat" && (
                <span className="px-2 py-0.5 rounded-full bg-green-300 text-green-900 text-[10px] font-bold uppercase tracking-wide">
                  ลูกค้าประจำ
                </span>
              )}
              {summary.segment === "new" && (
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
            {summary.latestService && (
              <p className="text-[11px] text-gray-500 mt-1 truncate">
                บริการ: {summary.latestService}
              </p>
            )}
          </div>
        </div>

        {/* Analytics row */}
        <div className="px-4 md:px-6 -mt-2 mb-3 grid grid-cols-3 gap-2 text-center">
          <Metric
            label="ค่าเฉลี่ยต่อครั้ง"
            value={
              summary.avgTicket > 0
                ? formatCurrency(summary.avgTicket)
                : "-"
            }
          />
          <Metric
            label="เข้ารับล่าสุด"
            value={
              summary.daysSinceLast === null
                ? "-"
                : summary.daysSinceLast === 0
                ? "วันนี้"
                : `${summary.daysSinceLast} วันก่อน`
            }
          />
          <Metric
            label="ความถี่ (ครั้ง/เดือน)"
            value={
              summary.visitsPerMonth > 0 ? String(summary.visitsPerMonth) : "-"
            }
          />
        </div>

        {summary.branches.length > 0 && (
          <div className="px-4 md:px-6 mb-2">
            <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
              สาขาที่เข้าใช้บริการ
            </p>
            <div className="flex flex-wrap gap-2">
              {summary.branches.map((b) => (
                <span
                  key={b.id}
                  className="px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-800 text-[11px] font-medium"
                >
                  {b.label} • {b.count} ครั้ง
                </span>
              ))}
            </div>
          </div>
        )}

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
                      สาขา
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
                  {orders.map((o) => {
                    const label =
                      o.service_name ??
                      getServiceByCode(o.service_code ?? undefined)?.nameTh ??
                      o.item_name ??
                      "-";
                    return (
                      <tr key={o.id} className="border-b border-gray-100">
                        <td className="px-4 py-3 text-sm text-gray-700">
                          {new Date(o.created_at).toLocaleDateString("th-TH")}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-800">
                          {label}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600">
                          {o.branch_id ? getBranchById(o.branch_id).shortLabel : "-"}
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 text-left">
      <p className="text-[10px] uppercase tracking-widest text-gray-500">
        {label}
      </p>
      <p className="mt-0.5 text-base font-semibold text-gray-800">{value}</p>
    </div>
  );
}

export default CustomerHistoryModal;
