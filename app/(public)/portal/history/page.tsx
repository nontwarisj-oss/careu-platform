"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type CompletedOrder = {
  id: string;
  refId: string;
  jobId: string | null;
  branchLabel: string | null;
  service: string;
  price: number;
  createdAt: string;
  dueDate: string | null;
  status: string;
};

export default function PortalHistoryPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<CompletedOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/portal/orders?limit=100", {
        cache: "no-store",
      });
      if (res.status === 401) {
        router.replace("/portal/signin");
        return;
      }
      const json = (await res.json()) as {
        ok?: boolean;
        orders?: CompletedOrder[];
      };
      const completed = (json.orders ?? []).filter(
        (o) =>
          o.status === "completed" ||
          o.status === "ready-for-pickup" ||
          o.status === "cancelled"
      );
      setOrders(completed);
      setLoading(false);
    })();
  }, [router]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold text-gray-900">ประวัติงาน</h1>
      <p className="text-sm text-gray-600">
        งานที่เสร็จสิ้น หรือพร้อมรับแล้ว / ถูกยกเลิก
      </p>

      {loading ? (
        <ul className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <li
              key={i}
              className="rounded-2xl border border-gray-100 bg-white p-4 animate-pulse"
            >
              <div className="h-3 w-20 bg-gray-200 rounded" />
              <div className="mt-2 h-5 w-3/5 bg-gray-200 rounded" />
            </li>
          ))}
        </ul>
      ) : orders.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          ยังไม่มีประวัติงานที่เสร็จสิ้น
        </div>
      ) : (
        <ul className="space-y-2">
          {orders.map((o) => (
            <li key={o.id}>
              <Link
                href={`/portal/orders/${o.id}`}
                className="block rounded-2xl border border-gray-200 bg-white p-4 hover:border-green-300 hover:shadow-md transition"
              >
                <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
                  {new Date(o.createdAt).toLocaleDateString("th-TH", {
                    dateStyle: "medium",
                  })}{" "}
                  · {o.branchLabel ?? "ไม่ระบุสาขา"}
                </p>
                <p className="mt-0.5 font-semibold text-gray-900">{o.service}</p>
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-xs text-gray-500">
                    Job {o.jobId ?? o.refId}
                  </span>
                  <span className="font-bold text-green-700">
                    ฿{Math.round(o.price).toLocaleString()}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
