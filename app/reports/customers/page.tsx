"use client";

import { useEffect, useMemo, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { ReportFrame } from "@/components/reports/ReportFrame";
import { SimpleBarChart } from "@/components/charts/SimpleBarChart";

type Customer = { id: string; name: string; phone: string };
type OrderLite = {
  customer_id: string | null;
  price: number;
  created_at: string;
};

export default function CustomersReportPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [orders, setOrders] = useState<OrderLite[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const [custRes, ordRes] = await Promise.all([
        supabase.from("customers").select("id, name, phone"),
        supabase.from("orders").select("customer_id, price, created_at"),
      ]);
      if (!custRes.error) {
        setCustomers((custRes.data ?? []) as Customer[]);
      }
      if (!ordRes.error) {
        setOrders(
          ((ordRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
            customer_id: (r.customer_id as string) ?? null,
            price: Number(r.price ?? 0),
            created_at: r.created_at as string,
          }))
        );
      }
      setIsLoading(false);
    })();
  }, []);

  const stats = useMemo(() => {
    const visitCount = new Map<string, number>();
    const spend = new Map<string, number>();
    const latest = new Map<string, string>();
    const firstSeen = new Map<string, string>();

    for (const o of orders) {
      if (!o.customer_id) continue;
      visitCount.set(o.customer_id, (visitCount.get(o.customer_id) ?? 0) + 1);
      spend.set(
        o.customer_id,
        (spend.get(o.customer_id) ?? 0) + Number(o.price || 0)
      );
      const prev = latest.get(o.customer_id);
      if (!prev || new Date(o.created_at) > new Date(prev)) {
        latest.set(o.customer_id, o.created_at);
      }
      const first = firstSeen.get(o.customer_id);
      if (!first || new Date(o.created_at) < new Date(first)) {
        firstSeen.set(o.customer_id, o.created_at);
      }
    }

    let vip = 0;
    let repeat = 0;
    let neu = 0;
    for (const c of customers) {
      const v = visitCount.get(c.id) ?? 0;
      if (v >= 5) vip += 1;
      else if (v >= 2) repeat += 1;
      else neu += 1;
    }

    const now = new Date();
    let newThisMonth = 0;
    for (const seen of firstSeen.values()) {
      const d = new Date(seen);
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
        newThisMonth += 1;
      }
    }

    const totalSpend = Array.from(spend.values()).reduce((a, b) => a + b, 0);

    const top = customers
      .map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        visits: visitCount.get(c.id) ?? 0,
        spend: spend.get(c.id) ?? 0,
        latest: latest.get(c.id) ?? null,
      }))
      .filter((c) => c.spend > 0)
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 10);

    return { vip, repeat, neu, newThisMonth, totalSpend, top };
  }, [customers, orders]);

  return (
    <ReportFrame
      title="รายงานลูกค้า"
      description="กลุ่มลูกค้า ใหม่/ประจำ/VIP และลูกค้ารายใหญ่"
    >
      {isLoading ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          กำลังโหลด...
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Kpi label="ลูกค้าทั้งหมด" value={String(customers.length)} tone="white" />
            <Kpi label="ลูกค้าใหม่ (≤ 1 ครั้ง)" value={String(stats.neu)} tone="white" />
            <Kpi label="ลูกค้าประจำ (≥ 2)" value={String(stats.repeat)} tone="green" />
            <Kpi label="VIP (≥ 5)" value={String(stats.vip)} tone="yellow" />
            <Kpi label="ลูกค้าใหม่เดือนนี้" value={String(stats.newThisMonth)} tone="green" />
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h3 className="text-lg font-bold text-gray-900 mb-3">10 ลูกค้ารายใหญ่</h3>
            {stats.top.length === 0 ? (
              <p className="text-sm text-gray-500">ยังไม่มีข้อมูลออเดอร์</p>
            ) : (
              <SimpleBarChart
                data={stats.top.map((c) => ({
                  label: `${c.name} • ${c.visits} ครั้ง`,
                  value: c.spend,
                }))}
              />
            )}
          </div>

          <p className="text-xs text-gray-500">
            ยอดใช้จ่ายรวม: {formatCurrency(stats.totalSpend)}
          </p>
        </>
      )}
    </ReportFrame>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "yellow" | "white";
}) {
  const toneClass = {
    green: "border-green-100 bg-green-50 text-green-900",
    yellow: "border-yellow-100 bg-yellow-50 text-yellow-900",
    white: "border-gray-100 bg-white text-gray-900",
  }[tone];
  return (
    <div className={`rounded-2xl border ${toneClass} p-4 shadow-sm`}>
      <p className="text-xs opacity-75">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
