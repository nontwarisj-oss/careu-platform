"use client";

import { useCallback, useEffect, useState } from "react";
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
    <div className="flex-1 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-8">
        <h1 className="text-3xl md:text-4xl font-bold text-gray-800">
          คำสั่งซ่อม
        </h1>
      </div>

      {errorMessage && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      <div className="bg-white p-6 rounded-xl border mb-8">
        <div className="grid gap-4">
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            disabled={isSubmitting}
            className="border p-3 rounded-lg"
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
            className="border p-3 rounded-lg"
          />

          <input
            type="number"
            placeholder="ราคา"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={isSubmitting}
            className="border p-3 rounded-lg"
          />

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as (typeof STATUS_OPTIONS)[number])}
            disabled={isSubmitting}
            className="border p-3 rounded-lg"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <button
            onClick={handleCreateOrder}
            disabled={isSubmitting || !customerId || !itemName.trim() || !price}
            className="bg-blue-600 text-white p-3 rounded-lg disabled:opacity-50"
          >
            บันทึกคำสั่งซ่อม
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">กำลังโหลด...</div>
        ) : orders.length === 0 ? (
          <div className="p-8 text-center text-gray-500">ไม่มีคำสั่งซ่อม</div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-100">
              <tr>
                <th className="text-left p-4">ลูกค้า</th>
                <th className="text-left p-4">งาน</th>
                <th className="text-left p-4">ราคา</th>
                <th className="text-left p-4">สถานะ</th>
                <th className="text-left p-4">วันที่</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="border-t">
                  <td className="p-4">{order.customer_name}</td>
                  <td className="p-4">{order.item_name}</td>
                  <td className="p-4">{formatCurrency(order.price)}</td>
                  <td className="p-4">
                    <select
                      value={order.status}
                      onChange={(e) => handleUpdateStatus(order.id, e.target.value)}
                      className="border p-2 rounded-lg"
                    >
                      {EDITABLE_STATUSES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                      {!EDITABLE_STATUSES.includes(
                        order.status as (typeof EDITABLE_STATUSES)[number]
                      ) && (
                        <option value={order.status}>{order.status}</option>
                      )}
                    </select>
                  </td>
                  <td className="p-4">
                    {new Date(order.created_at).toLocaleDateString("th-TH")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
