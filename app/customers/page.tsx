"use client";

import { useEffect, useState } from "react";
import supabase from "@/lib/supabase";

type Customer = {
  id: string;
  name: string;
  phone: string;
};

type Order = {
  id: string;
  customer_name: string;
  item_name: string;
  price: number;
  status: string;
};

export default function OrdersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);

  const [customerId, setCustomerId] = useState("");
  const [itemName, setItemName] = useState("");
  const [price, setPrice] = useState("");

  useEffect(() => {
    fetchCustomers();
    fetchOrders();
  }, []);

  async function fetchCustomers() {
    const { data } = await supabase
      .from("customers")
      .select("id,name,phone");

    setCustomers(data || []);
  }

  async function fetchOrders() {
    const { data } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false });

    setOrders(data || []);
  }

  async function handleCreateOrder() {
    if (!customerId || !itemName || !price) return;

    const customer = customers.find((c) => c.id === customerId);

    const { error } = await supabase.from("orders").insert({
      customer_id: customerId,
      customer_name: customer?.name || "",
      item_name: itemName,
      price: Number(price),
      status: "pending",
    });

    if (error) {
      alert(error.message);
      return;
    }

    setCustomerId("");
    setItemName("");
    setPrice("");

    fetchOrders();
  }

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-6">
        คำสั่งซ่อม
      </h1>

      <div className="bg-white p-6 rounded-xl border mb-8">
        <div className="grid gap-4">

          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
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
            className="border p-3 rounded-lg"
          />

          <input
            type="number"
            placeholder="ราคา"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="border p-3 rounded-lg"
          />

          <button
            onClick={handleCreateOrder}
            className="bg-blue-600 text-white p-3 rounded-lg"
          >
            บันทึกคำสั่งซ่อม
          </button>

        </div>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-100">
            <tr>
              <th className="text-left p-4">ลูกค้า</th>
              <th className="text-left p-4">งาน</th>
              <th className="text-left p-4">ราคา</th>
              <th className="text-left p-4">สถานะ</th>
            </tr>
          </thead>

          <tbody>
            {orders.map((order) => (
              <tr key={order.id} className="border-t">
                <td className="p-4">{order.customer_name}</td>
                <td className="p-4">{order.item_name}</td>
                <td className="p-4">฿{order.price}</td>
                <td className="p-4">{order.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}