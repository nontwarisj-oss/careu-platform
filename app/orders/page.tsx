"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { OrderDetailModal } from "@/components/OrderDetailModal";
import { useAuth } from "@/lib/authContext";
import { OrderStatusBadge } from "@/components/StatusBadge";
import {
  ORDER_STATUS_FLOW,
  orderStatusLabel,
} from "@/lib/statusBadges";
import { triggerLifecycleEvent } from "@/lib/lifecycleClient";
import type { LifecycleEvent } from "@/lib/lifecycleNotifier";

function mapStatusToLifecycleEvent(
  before: string | null,
  after: string
): LifecycleEvent | null {
  // Only "into" transitions trigger a customer-facing notification.
  // Reverse changes (e.g. completed → in-progress, a fix-up flow) do
  // not re-notify — the customer was already told.
  if (after === "in-progress" && before !== "in-progress") return "repair_started";
  if (after === "ready-for-pickup" && before !== "ready-for-pickup") return "ready_for_pickup";
  if (after === "completed" && before !== "completed") return "order_completed";
  return null;
}

type Order = {
  id: string;
  customer_id: string | null;
  customer_name: string;
  item_name: string;
  price: number;
  status: string;
  created_at: string;
};

const EDITABLE_STATUSES = ORDER_STATUS_FLOW;
const FILTER_STATUSES = ["all", ...ORDER_STATUS_FLOW] as const;

type FilterStatus = (typeof FILTER_STATUSES)[number];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export default function OrdersPage() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Filters
  const [orderSearch, setOrderSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<FilterStatus>("all");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  // Detail drawer
  const [detailOrder, setDetailOrder] = useState<Order | null>(null);

  const fetchOrders = useCallback(async () => {
    const { data, error } = await supabase
      .from("orders")
      .select("id, customer_id, customer_name, item_name, price, status, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      setErrorMessage(error.message);
      setOrders([]);
      return;
    }

    setOrders((data ?? []) as Order[]);
  }, []);

  useEffect(() => {
    void (async () => {
      setIsLoading(true);
      setErrorMessage(null);
      await fetchOrders();
      setIsLoading(false);
    })();
  }, [fetchOrders]);

  const summary = useMemo(() => {
    const pending = orders.filter((o) => o.status === "pending").length;
    const inProgress = orders.filter((o) => o.status === "in-progress").length;
    const completed = orders.filter((o) => o.status === "completed").length;
    return { pending, inProgress, completed, total: orders.length };
  }, [orders]);

  const handleUpdateStatus = async (orderId: string, newStatus: string) => {
    setErrorMessage(null);
    const previous = orders;
    const previousStatus =
      previous.find((o) => o.id === orderId)?.status ?? null;
    setOrders((curr) =>
      curr.map((o) => (o.id === orderId ? { ...o, status: newStatus } : o))
    );

    const { error } = await supabase
      .from("orders")
      .update({ status: newStatus })
      .eq("id", orderId);

    if (error) {
      setErrorMessage(error.message);
      setOrders(previous);
      return;
    }
    // Best-effort audit — table may not exist yet on un-migrated DBs.
    const auditRes = await supabase.from("order_audit_log").insert({
      order_id: orderId,
      action: "status_changed",
      before_value: previousStatus,
      after_value: newStatus,
      changed_by: user?.uid ?? null,
    });
    if (
      auditRes.error &&
      !/column .* does not exist|schema cache|relation .* does not exist/i.test(
        auditRes.error.message
      )
    ) {
      console.warn("[orders] audit write failed", auditRes.error.message);
    }

    // Lifecycle notification trigger — fire-and-forget. The notifier
    // dedups, consults preferences, and enqueues the message; it never
    // blocks the OPS flow.
    const lifecycleEvent = mapStatusToLifecycleEvent(previousStatus, newStatus);
    if (lifecycleEvent) {
      void triggerLifecycleEvent(lifecycleEvent, orderId);
    }
  };

  const filteredOrders = useMemo(() => {
    const q = orderSearch.trim().toLowerCase();
    const fromDate = dateFrom ? startOfDay(new Date(dateFrom)) : null;
    const toDate = dateTo ? endOfDay(new Date(dateTo)) : null;

    return orders.filter((o) => {
      if (statusFilter !== "all" && o.status !== statusFilter) return false;

      if (fromDate || toDate) {
        const created = new Date(o.created_at);
        if (fromDate && created < fromDate) return false;
        if (toDate && created > toDate) return false;
      }

      if (q) {
        const idStart = o.id.slice(0, 8).toLowerCase();
        const matches =
          o.customer_name.toLowerCase().includes(q) ||
          o.item_name.toLowerCase().includes(q) ||
          idStart.includes(q);
        if (!matches) return false;
      }

      return true;
    });
  }, [orders, orderSearch, statusFilter, dateFrom, dateTo]);

  const isFilterActive =
    orderSearch.trim() !== "" ||
    statusFilter !== "all" ||
    dateFrom !== "" ||
    dateTo !== "";

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-8 flex flex-col gap-2 border-l-4 border-yellow-400 pl-4">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">CareU OPS</p>
        <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">คำสั่งซ่อม</h1>
        <p className="text-sm text-gray-600">
          ค้นหา กรองสถานะ ดูรายละเอียด อัปเดตสถานะ และพิมพ์เอกสาร
        </p>
      </div>

      {errorMessage && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {/* Status summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">ทั้งหมด</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{summary.total}</p>
        </div>
        <div className="rounded-2xl border border-yellow-100 bg-yellow-50 p-4 shadow-sm">
          <p className="text-xs text-yellow-800">รอดำเนิน</p>
          <p className="mt-1 text-2xl font-bold text-yellow-900">{summary.pending}</p>
        </div>
        <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4 shadow-sm">
          <p className="text-xs text-blue-800">กำลังซ่อม</p>
          <p className="mt-1 text-2xl font-bold text-blue-900">{summary.inProgress}</p>
        </div>
        <div className="rounded-2xl border border-green-100 bg-green-50 p-4 shadow-sm">
          <p className="text-xs text-green-800">เสร็จสิ้น</p>
          <p className="mt-1 text-2xl font-bold text-green-900">{summary.completed}</p>
        </div>
      </div>

      {/* Create-new-job belongs to /intake — Orders is a management view.
          A single clear entry point instead of an embedded duplicate form. */}
      <div className="mb-8 flex flex-col gap-3 rounded-2xl border border-green-100 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-gray-900">รับงานใหม่</h2>
          <p className="text-xs text-gray-500">
            สร้างใบงานใหม่ได้ที่หน้า “รับงานหน้าร้าน” — งานที่บันทึกจะแสดงในรายการด้านล่าง
          </p>
        </div>
        <Link
          href="/intake"
          className="shrink-0 rounded-xl bg-green-700 px-5 py-3 text-center text-sm font-semibold text-white hover:bg-green-800"
        >
          + ไปหน้ารับงาน
        </Link>
      </div>

      {/* Orders table */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-gray-100 p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">รายการงานซ่อม</h2>
            <p className="text-xs text-gray-500">
              แสดง {filteredOrders.length} จาก {orders.length} รายการ
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:max-w-2xl md:w-full">
            <input
              type="search"
              value={orderSearch}
              onChange={(e) => setOrderSearch(e.target.value)}
              placeholder="ค้นหาลูกค้า / งาน / เลขที่"
              aria-label="ค้นหาคำสั่งซ่อม"
              autoComplete="off"
              className="rounded-xl border border-gray-200 px-3 py-3 text-base sm:text-sm outline-none focus:ring-2 focus:ring-green-500 col-span-2"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as FilterStatus)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500 col-span-2 sm:col-span-1"
            >
              {FILTER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "ทุกสถานะ" : orderStatusLabel(s)}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
              aria-label="from date"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
              aria-label="to date"
            />
          </div>
        </div>

        {isFilterActive && (
          <div className="flex items-center justify-end gap-3 px-4 py-2 border-b border-gray-100 text-xs text-gray-500">
            <button
              type="button"
              onClick={() => {
                setOrderSearch("");
                setStatusFilter("all");
                setDateFrom("");
                setDateTo("");
              }}
              className="text-green-700 hover:text-green-800 font-medium"
            >
              ล้างตัวกรอง
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="p-8 text-center text-gray-500">กำลังโหลด...</div>
        ) : filteredOrders.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {orders.length === 0 ? "ไม่มีคำสั่งซ่อม" : "ไม่พบรายการตามตัวกรอง"}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="text-left p-4">ลูกค้า</th>
                  <th className="text-left p-4">งาน</th>
                  <th className="text-left p-4">ราคา</th>
                  <th className="text-left p-4">สถานะ</th>
                  <th className="text-left p-4">วันที่</th>
                  <th className="text-left p-4 print:hidden">เอกสาร</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((order) => (
                  <tr
                    key={order.id}
                    onClick={() => setDetailOrder(order)}
                    className="border-t border-gray-100 hover:bg-green-50/30 cursor-pointer"
                  >
                    <td className="p-4 font-medium text-gray-900">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetailOrder(order);
                        }}
                        className="text-left text-green-800 hover:underline"
                      >
                        {order.customer_name}
                      </button>
                    </td>
                    <td className="p-4 text-gray-700">{order.item_name}</td>
                    <td className="p-4 font-semibold text-green-700">
                      {formatCurrency(order.price)}
                    </td>
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <OrderStatusBadge status={order.status} />
                        <select
                          value={order.status}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            e.stopPropagation();
                            void handleUpdateStatus(order.id, e.target.value);
                          }}
                          className="rounded-lg border border-gray-200 px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500 min-h-[40px]"
                          aria-label="เปลี่ยนสถานะ"
                        >
                          {EDITABLE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {orderStatusLabel(s)}
                            </option>
                          ))}
                          {!EDITABLE_STATUSES.includes(
                            order.status as (typeof EDITABLE_STATUSES)[number]
                          ) && (
                            <option value={order.status}>
                              {orderStatusLabel(order.status)}
                            </option>
                          )}
                        </select>
                      </div>
                    </td>
                    <td className="p-4 text-gray-600">
                      {new Date(order.created_at).toLocaleDateString("th-TH")}
                    </td>
                    <td className="p-4 print:hidden">
                      <Link
                        href={`/orders/${order.id}/document`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-sm text-green-700 hover:text-green-800 font-medium"
                      >
                        ดูเอกสาร →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <OrderDetailModal
        order={detailOrder}
        onClose={() => setDetailOrder(null)}
      />
    </div>
  );
}
