"use client";

// Phase J — /production/queue. Paid, unassigned orders ready for a
// technician, priority-sorted, with a recommendation per job. Owner/Admin
// confirm the assignment — no auto-assign. Owner / Admin only.

import { useCallback, useEffect, useState } from "react";
import { RouteGuard } from "@/components/RouteGuard";
import { formatCurrency } from "@/lib/utils";
import {
  PRIORITY_LABELS_TH,
  type AssignmentPriority,
} from "@/lib/productionQueue";

type QueueOrder = {
  id: string;
  jobId: string | null;
  customerName: string;
  itemName: string;
  price: number;
  paymentStatus: string;
  urgent: boolean;
  dueDate: string | null;
  createdAt: string;
  priority: AssignmentPriority;
};
type Recommendation = {
  technicianId: string;
  displayName: string;
  score: number;
  reasonsTh: string[];
  warningsTh: string[];
};
type QueueItem = { order: QueueOrder; recommendations: Recommendation[] };
type TechOption = { id: string; displayName: string };

const PRIORITY_BADGE: Record<AssignmentPriority, string> = {
  URGENT: "border-red-300 bg-red-50 text-red-700",
  DUE_SOON: "border-orange-300 bg-orange-50 text-orange-800",
  NORMAL: "border-gray-200 bg-gray-50 text-gray-600",
};

export default function ProductionQueuePage() {
  return (
    <RouteGuard page="admin">
      <QueueInner />
    </RouteGuard>
  );
}

function QueueInner() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [technicians, setTechnicians] = useState<TechOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/production/queue");
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        queue?: QueueItem[];
        technicians?: TechOption[];
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `โหลดไม่สำเร็จ (HTTP ${res.status})`);
      } else {
        setQueue(json.queue ?? []);
        setTechnicians(json.technicians ?? []);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "โหลดคิวงานไม่สำเร็จ");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const assign = async (orderId: string, technicianId: string) => {
    if (!technicianId) {
      setError("เลือกช่างก่อนมอบหมาย");
      return;
    }
    setBusyOrderId(orderId);
    setError(null);
    try {
      const res = await fetch("/api/production/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", orderId, technicianId }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "มอบหมายงานไม่สำเร็จ");
      } else {
        setMessage("มอบหมายงานแล้ว — ดูได้ที่หน้างานที่มอบหมาย");
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "มอบหมายงานไม่สำเร็จ");
    }
    setBusyOrderId(null);
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-5 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 border-l-4 border-yellow-400 pl-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS
          </p>
          <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
            คิวงานช่าง
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            งานที่ชำระเงินแล้วและยังไม่ได้มอบหมาย — งานด่วน/ใกล้กำหนดขึ้นก่อน
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="self-start rounded-lg border border-green-600 px-4 py-2 text-sm font-semibold text-green-700 hover:bg-green-50"
        >
          รีเฟรช
        </button>
      </div>

      {message && (
        <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800 flex justify-between">
          <span>{message}</span>
          <button onClick={() => setMessage(null)} aria-label="dismiss">
            ✕
          </button>
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center text-gray-500">
          กำลังโหลด...
        </div>
      ) : queue.length === 0 ? (
        <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center text-gray-500">
          ไม่มีงานที่ชำระเงินแล้วรอมอบหมาย
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {queue.map((item) => (
            <QueueCard
              key={item.order.id}
              item={item}
              technicians={technicians}
              busy={busyOrderId === item.order.id}
              onAssign={assign}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QueueCard({
  item,
  technicians,
  busy,
  onAssign,
}: {
  item: QueueItem;
  technicians: TechOption[];
  busy: boolean;
  onAssign: (orderId: string, technicianId: string) => void;
}) {
  const { order, recommendations } = item;
  const top = recommendations[0];
  const [picked, setPicked] = useState(top?.technicianId ?? "");

  const created = order.createdAt
    ? new Date(order.createdAt).toLocaleDateString("th-TH")
    : "-";

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-base font-bold text-gray-900">
            {order.jobId ?? `#${order.id.slice(0, 8).toUpperCase()}`}
          </p>
          <p className="text-sm text-gray-800 truncate">
            {order.customerName || "(ไม่ระบุชื่อ)"}
          </p>
          <p className="text-xs text-gray-500 truncate">{order.itemName}</p>
        </div>
        <div className="text-right">
          <span
            className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-bold ${
              PRIORITY_BADGE[order.priority]
            }`}
          >
            {PRIORITY_LABELS_TH[order.priority]}
          </span>
          <p className="mt-1 text-sm font-bold text-green-700">
            {formatCurrency(order.price)}
          </p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
        <span className="rounded-full bg-green-100 border border-green-300 px-2 py-0.5 font-semibold text-green-800">
          ชำระแล้ว
        </span>
        <span className="rounded-full bg-gray-50 border border-gray-200 px-2 py-0.5 text-gray-600">
          รับงาน {created}
        </span>
        {order.dueDate && (
          <span className="rounded-full bg-orange-50 border border-orange-200 px-2 py-0.5 text-orange-800">
            กำหนดรับ {order.dueDate}
          </span>
        )}
      </div>

      {/* Recommendation */}
      <div className="mt-3 rounded-lg border border-green-200 bg-green-50/60 p-2.5">
        {top ? (
          <>
            <p className="text-xs font-semibold text-green-800">
              แนะนำช่าง: {top.displayName}
            </p>
            {top.reasonsTh.length > 0 && (
              <p className="text-[11px] text-green-700 mt-0.5">
                {top.reasonsTh.join(" · ")}
              </p>
            )}
            {top.warningsTh.length > 0 && (
              <p className="text-[11px] text-amber-700 mt-0.5">
                ⚠ {top.warningsTh.join(" · ")}
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-gray-500">
            ยังไม่มีช่างที่แนะนำได้ — เลือกช่างเองด้านล่าง
          </p>
        )}
      </div>

      {/* Assign */}
      <div className="mt-3 flex gap-2">
        <select
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          className="flex-1 rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="">— เลือกช่าง —</option>
          {technicians.map((t) => {
            const rec = recommendations.find(
              (r) => r.technicianId === t.id
            );
            return (
              <option key={t.id} value={t.id}>
                {t.displayName}
                {rec ? ` (คะแนน ${rec.score})` : ""}
              </option>
            );
          })}
        </select>
        <button
          onClick={() => onAssign(order.id, picked)}
          disabled={busy || !picked}
          className="rounded-lg bg-green-700 px-4 py-2 text-sm font-bold text-white hover:bg-green-800 disabled:opacity-50"
        >
          {busy ? "..." : "มอบหมาย"}
        </button>
      </div>
    </div>
  );
}
