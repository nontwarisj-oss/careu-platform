"use client";

import { useEffect, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";

type InvoiceRow = {
  id: string;
  customer_name: string;
  item_name: string;
  price: number;
  status: string;
  created_at: string;
};

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);

  useEffect(() => {
    fetchInvoices();
  }, []);

  async function fetchInvoices() {
    const { data } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false });

    setInvoices(data || []);
  }

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-6">
        ใบเสร็จ
      </h1>

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-100">
            <tr>
              <th className="text-left p-4">ลูกค้า</th>
              <th className="text-left p-4">รายการ</th>
              <th className="text-left p-4">ราคา</th>
              <th className="text-left p-4">สถานะ</th>
              <th className="text-left p-4">วันที่</th>
            </tr>
          </thead>

          <tbody>
            {invoices.map((invoice) => (
              <tr key={invoice.id} className="border-t">
                <td className="p-4">
                  {invoice.customer_name}
                </td>

                <td className="p-4">
                  {invoice.item_name}
                </td>

                <td className="p-4">
                  {formatCurrency(invoice.price)}
                </td>

                <td className="p-4">
                  {invoice.status}
                </td>

                <td className="p-4">
                  {new Date(invoice.created_at).toLocaleDateString("th-TH")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}