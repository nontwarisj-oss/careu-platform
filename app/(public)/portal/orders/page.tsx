"use client";

// /portal/orders — the customer's order list with Phase 27A filters:
// status chips, branch chips, a date range, and a Job ID search.
// Filtering is client-side over the loaded set (≤ 50 rows) so it is
// instant + offline-friendly; branch chips are derived from the
// customer's own orders (never a hardcoded branch list).

import { useEffect, useMemo, useState } from "react";
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

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "ทั้งหมด" },
  { value: "pending", label: "รอดำเนิน" },
  { value: "in-progress", label: "กำลังซ่อม" },
  { value: "ready-for-pickup", label: "พร้อมรับ" },
  { value: "completed", label: "เสร็จสิ้น" },
  { value: "cancelled", label: "ยกเลิก" },
];

export default function PortalOrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<PortalOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state.
  const [status, setStatus] = useState("");
  const [branch, setBranch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/portal/orders?limit=50", {
        cache: "no-store",
      });
      if (res.status === 401) {
        router.replace("/portal/signin?expired=1");
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

  // Branch chips — derived from the customer's own orders only.
  const branchOptions = useMemo(() => {
    const set = new Set<string>();
    for (const o of orders) if (o.branchLabel) set.add(o.branchLabel);
    return Array.from(set).sort();
  }, [orders]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      if (status && o.status !== status) return false;
      if (branch && o.branchLabel !== branch) return false;
      if (q) {
        const hay = `${o.jobId ?? ""} ${o.refId}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (from && o.createdAt.slice(0, 10) < from) return false;
      if (to && o.createdAt.slice(0, 10) > to) return false;
      return true;
    });
  }, [orders, status, branch, query, from, to]);

  const hasActiveFilter =
    Boolean(status || branch || from || to || query.trim());

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold text-gray-900">งานของฉัน</h1>

      {!loading && !error && orders.length > 0 && (
        <section className="rounded-2xl border border-gray-200 bg-white p-3 space-y-3">
          {/* Job ID search */}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาด้วย Job ID..."
            className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
          />

          {/* Status chips — horizontally scrollable on mobile */}
          <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setStatus(s.value)}
                className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  status === s.value
                    ? "border-green-600 bg-green-600 text-white"
                    : "border-gray-200 bg-gray-50 text-gray-700"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* Branch chips — only when the customer has used >1 branch */}
          {branchOptions.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
              <button
                type="button"
                onClick={() => setBranch("")}
                className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${
                  branch === ""
                    ? "border-green-600 bg-green-600 text-white"
                    : "border-gray-200 bg-gray-50 text-gray-700"
                }`}
              >
                ทุกสาขา
              </button>
              {branchOptions.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBranch(b)}
                  className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${
                    branch === b
                      ? "border-green-600 bg-green-600 text-white"
                      : "border-gray-200 bg-gray-50 text-gray-700"
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>
          )}

          {/* Date range */}
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-gray-600">
              ตั้งแต่
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="rounded-lg border border-gray-200 px-2 py-1 text-xs"
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-gray-600">
              ถึง
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="rounded-lg border border-gray-200 px-2 py-1 text-xs"
              />
            </label>
            {hasActiveFilter && (
              <button
                type="button"
                onClick={() => {
                  setStatus("");
                  setBranch("");
                  setFrom("");
                  setTo("");
                  setQuery("");
                }}
                className="ml-auto text-xs font-semibold text-green-700 underline"
              >
                ล้างตัวกรอง
              </button>
            )}
          </div>
        </section>
      )}

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
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          ไม่พบงานที่ตรงกับตัวกรอง
        </div>
      ) : (
        <>
          <p className="text-xs text-gray-500">
            แสดง {filtered.length} จาก {orders.length} งาน
          </p>
          <ul className="space-y-3">
            {filtered.map((o) => (
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
        </>
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
