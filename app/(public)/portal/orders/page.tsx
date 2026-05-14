"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type PortalOrder = {
  id: string;
  refId: string;
  jobId: string | null;
  branchLabel: string | null;
  status: string;
  statusLabel: string;
  paymentStatus: string;
  paymentLabel: string;
  service: string;
  price: number;
  urgent: boolean;
  dueDate: string | null;
  createdAt: string;
};

const STATUS_TONE: Record<string, string> = {
  pending: "border-yellow-200 bg-yellow-50 text-yellow-800",
  "in-progress": "border-blue-200 bg-blue-50 text-blue-800",
  completed: "border-green-200 bg-green-50 text-green-800",
  "ready-for-pickup": "border-purple-200 bg-purple-50 text-purple-800",
  cancelled: "border-gray-200 bg-gray-50 text-gray-600",
};

export default function PortalOrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<PortalOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/portal/orders?limit=50", {
        cache: "no-store",
      });
      if (res.status === 401) {
        router.replace("/portal/signin");
        return;
      }
      const json = (await res.json()) as {
        ok?: boolean;
        orders?: PortalOrder[];
        reason?: string;
      };
      if (!json.ok) {
        setError(json.reason ?? `ดึงรายการไม่สำเร็จ (HTTP ${res.status})`);
        setLoading(false);
        return;
      }
      setOrders(json.orders ?? []);
      setLoading(false);
    })();
  }, [router]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold text-gray-900">งานของฉัน</h1>

      {loading ? (
        <SkeletonList />
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          {error}
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          ยังไม่มีงานในระบบ — เมื่อแวะที่สาขาครั้งหน้า งานของคุณจะแสดงที่นี่
        </div>
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => (
            <li key={o.id}>
              <Link
                href={`/portal/orders/${o.id}`}
                className="block rounded-2xl border border-gray-200 bg-white p-4 hover:border-green-300 hover:shadow-md transition"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
                      Job {o.jobId ?? o.refId}
                    </p>
                    <p className="mt-0.5 font-bold text-gray-900 truncate">
                      {o.service}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {o.branchLabel ?? "ไม่ระบุสาขา"} ·{" "}
                      {new Date(o.createdAt).toLocaleDateString("th-TH")}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-bold text-green-700">
                      ฿{Math.round(o.price).toLocaleString()}
                    </p>
                    {o.urgent && (
                      <span className="inline-block mt-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-800">
                        ด่วน
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                  <span
                    className={`rounded-full border px-2 py-0.5 font-semibold ${
                      STATUS_TONE[o.status] ??
                      "border-gray-200 bg-gray-50 text-gray-700"
                    }`}
                  >
                    {o.statusLabel}
                  </span>
                  <span className="rounded-full border border-gray-200 bg-gray-50 text-gray-700 px-2 py-0.5">
                    {o.paymentLabel}
                  </span>
                  {o.dueDate && (
                    <span className="rounded-full border border-blue-200 bg-blue-50 text-blue-800 px-2 py-0.5">
                      รับ {new Date(o.dueDate).toLocaleDateString("th-TH")}
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SkeletonList() {
  return (
    <ul className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <li
          key={i}
          className="rounded-2xl border border-gray-100 bg-white p-4 animate-pulse"
        >
          <div className="h-3 w-24 bg-gray-200 rounded" />
          <div className="mt-2 h-5 w-3/5 bg-gray-200 rounded" />
          <div className="mt-2 h-3 w-2/5 bg-gray-100 rounded" />
        </li>
      ))}
    </ul>
  );
}
