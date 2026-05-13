"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";

type Customer = {
  id: string;
  name: string;
  phone: string;
};

type Order = {
  id: string;
  customer_id: string | null;
  customer_name: string;
  item_name: string;
  price: number;
  status: string;
  created_at: string;
};

const STATUS_OPTIONS = ["pending", "in-progress", "completed", "ready-for-pickup"] as const;
const EDITABLE_STATUSES = ["pending", "in-progress", "completed"] as const;

const statusLabels: Record<string, string> = {
  pending: "รอดำเนิน",
  "in-progress": "กำลังซ่อม",
  completed: "เสร็จสิ้น",
  "ready-for-pickup": "พร้อมรับ",
};

const statusBadgeClasses: Record<string, string> = {
  pending: "border-yellow-200 bg-yellow-50 text-yellow-800",
  "in-progress": "border-blue-200 bg-blue-50 text-blue-800",
  completed: "border-green-200 bg-green-50 text-green-800",
  "ready-for-pickup": "border-purple-200 bg-purple-50 text-purple-800",
};

export default function OrdersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [customerId, setCustomerId] = useState("");
  const [itemName, setItemName] = useState("");
  const [price, setPrice] = useState("");
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const fetchCustomers = useCallback(async () => {
    const { data, error } = await supabase
      .from("customers")
      .select("id, name, phone")
      .order("name", { ascending: true });

    if (error) {
      setErrorMessage(error.message);
      setCustomers([]);
      return;
    }

    setCustomers((data ?? []) as Customer[]);
  }, []);

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
      await Promise.all([fetchCustomers(), fetchOrders()]);
      setIsLoading(false);
    })();
  }, [fetchCustomers, fetchOrders]);

  const filteredOrders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return orders.filter((order) => {
      const matchesStatus = statusFilter === "all" || order.status === statusFilter;
      const matchesSearch =
        !q ||
        [order.customer_name, order.item_name, order.id]
          .join(" ")
          .toLowerCase()
          .includes(q);
      return matchesStatus && matchesSearch;
    });
  }, [orders, searchQuery, statusFilter]);

  const summary = useMemo(() => {
    const pending = orders.filter((o) => o.status === "pending").length;
    const inProgress = orders.filter((o) => o.status === "in-progress").length;
    const completed = orders.filter((o) => o.status === "completed").length;
    return { pending, inProgress, completed, total: orders.length };
  }, [orders]);

  const handleCreateOrder = async () => {
    if (!customerId || !itemName.trim() || !price) {
      return;
    }

    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      setErrorMessage("Price must be a non-negative number");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    const customer = customers.find((c) => c.id === customerId);

    const { error } = await supabase.from("orders").insert({
      customer_id: customerId,
      customer_name: customer?.name ?? "",
      item_name: itemName.trim(),
      price: numericPrice,
      status,
    });

    if (error) {
      setErrorMessage(error.message);
      setIsSubmitting(false);
      return;
    }

    setCustomerId("");
    setItemName("");
    setPrice("");
    setStatus("pending");
    setIsSubmitting(false);
    await fetchOrders();
  };

  const handleUpdateStatus = async (orderId: string, newStatus: string) => {
    setErrorMessage(null);
    const previous = orders;
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
    }
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-8 flex flex-col gap-2 border-l-4 border-yellow-400 pl-4">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">CareU OPS</p>
        <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">คำสั่งซ่อม</h1>
        <p className="text-sm text-gray-600">จัดการงานซ่อม ค้นหา กรองสถานะ และรองรับประวัติลูกค้าในเฟสต่อไป</p>
      </div>

      {errorMessage && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

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

      <div className="bg-white p-5 md:p-6 rounded-2xl border border-green-100 shadow-sm mb-8">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-gray-900">เพิ่มคำสั่งซ่อม</h2>
            <p className="text-xs text-gray-500">โครงสร้างพร้อมต่อยอด branch_id / customer history / repeat customer detection</p>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            disabled={isSubmitting}
            className="rounded-xl border border-gray-200 bg-white p-3 outline-none focus:ring-2 focus:ring-green-500 lg:col-span-2"
          >
            <option value="">เลือกลูกค้า</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name} ({customer.phone})
              </option>
            ))}
          </select>

          <input
            type="text"
            placeholder="รายการซ่อม"
            value={itemName}
            onChange={(e) => setItemName(e.target.value)}
            disabled={isSubmitting}
            className="rounded-xl border border-gray-200 p-3 outline-none focus:ring-2 focus:ring-green-500"
          />

          <input
            type="number"
            placeholder="ราคา"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={isSubmitting}
            className="rounded-xl border border-gray-200 p-3 outline-none focus:ring-2 focus:ring-green-500"
          />

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as (typeof STATUS_OPTIONS)[number])}
            disabled={isSubmitting}
            className="rounded-xl border border-gray-200 bg-white p-3 outline-none focus:ring-2 focus:ring-green-500"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{statusLabels[s] ?? s}</option>
            ))}
          </select>

          <button
            onClick={handleCreateOrder}
            disabled={isSubmitting || !customerId || !itemName.trim() || !price}
            className="rounded-xl bg-green-700 p-3 font-semibold text-white transition hover:bg-green-800 disabled:opacity-50 md:col-span-2 lg:col-span-5"
          >
            บันทึกคำสั่งซ่อม
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-gray-100 p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">รายการงานซ่อม</h2>
            <p className="text-xs text-gray-500">แสดง {filteredOrders.length} จาก {orders.length} รายการ</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ค้นหาลูกค้า / งาน / เลขที่"
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="all">ทุกสถานะ</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{statusLabels[s] ?? s}</option>
              ))}
            </select>
          </div>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-gray-500">กำลังโหลด...</div>
        ) : filteredOrders.length === 0 ? (
          <div className="p-8 text-center text-gray-500">ไม่พบคำสั่งซ่อม</div>
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
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((order) => (
                  <tr key={order.id} className="border-t border-gray-100 hover:bg-green-50/30">
                    <td className="p-4 font-medium text-gray-900">{order.customer_name}</td>
                    <td className="p-4 text-gray-700">{order.item_name}</td>
                    <td className="p-4 font-semibold text-green-700">{formatCurrency(order.price)}</td>
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusBadgeClasses[order.status] ?? "border-gray-200 bg-gray-50 text-gray-700"}`}>
                          {statusLabels[order.status] ?? order.status}
                        </span>
                        <select
                          value={order.status}
                          onChange={(e) => void handleUpdateStatus(order.id, e.target.value)}
                          className="rounded-lg border border-gray-200 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
                        >
                          {EDITABLE_STATUSES.map((s) => (
                            <option key={s} value={s}>{statusLabels[s] ?? s}</option>
                          ))}
                          {!EDITABLE_STATUSES.includes(
                            order.status as (typeof EDITABLE_STATUSES)[number]
                          ) && (
                            <option value={order.status}>{statusLabels[order.status] ?? order.status}</option>
                          )}
                        </select>
                      </div>
                    </td>
                    <td className="p-4 text-gray-600">
                      {new Date(order.created_at).toLocaleDateString("th-TH")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
