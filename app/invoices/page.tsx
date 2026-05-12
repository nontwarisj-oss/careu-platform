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

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-6">
        ใบเสร็จ
      </h1>

      {errorMessage && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      <div className="bg-white rounded-xl border overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">กำลังโหลด...</div>
        ) : invoices.length === 0 ? (
          <div className="p-8 text-center text-gray-500">ไม่มีใบเสร็จ</div>
        ) : (
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
                  <td className="p-4">{invoice.customer_name}</td>
                  <td className="p-4">{invoice.item_name}</td>
                  <td className="p-4">{formatCurrency(invoice.price)}</td>
                  <td className="p-4">{invoice.status}</td>
                  <td className="p-4">
                    {new Date(invoice.created_at).toLocaleDateString("th-TH")}
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
