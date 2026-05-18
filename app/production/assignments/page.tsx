"use client";

// Phase J — /production/assignments. Assigned jobs by date / technician /
// status, with per-technician daily KPI vs the 3× wage target. Owner/Admin.

import { useCallback, useEffect, useState } from "react";
import { RouteGuard } from "@/components/RouteGuard";
import { formatCurrency } from "@/lib/utils";
import {
  ASSIGNMENT_STATUSES,
  ASSIGNMENT_STATUS_LABELS_TH,
  PRIORITY_LABELS_TH,
  type AssignmentPriority,
  type AssignmentStatus,
} from "@/lib/productionQueue";

type Assignment = {
  id: string;
  orderId: string;
  jobId: string | null;
  customerName: string;
  itemName: string;
  price: number;
  technicianId: string;
  technicianName: string;
  assignedDate: string;
  dueDate: string | null;
  priority: string;
  status: string;
  adminNote: string | null;
  technicianNote: string | null;
};
type Kpi = {
  technicianId: string;
  technicianName: string;
  dailyWage: number;
  targetWorkValue: number;
  assignedWorkValueToday: number;
  completedWorkValueToday: number;
  assignedJobCount: number;
  completedJobCount: number;
  targetPercentage: number;
};
type TechOption = { id: string; displayName: string };

const STATUS_BADGE: Record<string, string> = {
  ASSIGNED: "border-green-300 bg-green-50 text-green-800",
  IN_PROGRESS: "border-blue-300 bg-blue-50 text-blue-800",
  QC_WAITING: "border-amber-300 bg-amber-50 text-amber-800",
  REWORK: "border-orange-300 bg-orange-50 text-orange-800",
  DONE: "border-gray-300 bg-gray-100 text-gray-700",
  CANCELLED: "border-red-300 bg-red-50 text-red-700",
};

export default function AssignmentsPage() {
  return (
    <RouteGuard page="admin">
      <AssignmentsInner />
    </RouteGuard>
  );
}

function AssignmentsInner() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [technicianId, setTechnicianId] = useState("");
  const [status, setStatus] = useState("");
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [technicians, setTechnicians] = useState<TechOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ date });
      if (technicianId) params.set("technicianId", technicianId);
      if (status) params.set("status", status);
      const res = await fetch(`/api/production/assignments?${params}`);
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        assignments?: Assignment[];
        kpis?: Kpi[];
        technicians?: TechOption[];
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `โหลดไม่สำเร็จ (HTTP ${res.status})`);
      } else {
        setAssignments(json.assignments ?? []);
        setKpis(json.kpis ?? []);
        setTechnicians(json.technicians ?? []);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "โหลดงานไม่สำเร็จ");
    }
    setLoading(false);
  }, [date, technicianId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateStatus = async (id: string, next: AssignmentStatus) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch("/api/production/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", assignmentId: id, status: next }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) setError(json.error ?? "อัปเดตไม่สำเร็จ");
      else await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "อัปเดตไม่สำเร็จ");
    }
    setBusyId(null);
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-5 border-l-4 border-yellow-400 pl-4">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
          CareU OPS
        </p>
        <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
          งานที่มอบหมาย
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          ติดตามงานช่าง สถานะการผลิต และเป้าหมายค่างานต่อวัน
        </p>
      </div>

      {/* Filters */}
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">
            วันที่มอบหมาย
          </span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">
            ช่าง
          </span>
          <select
            value={technicianId}
            onChange={(e) => setTechnicianId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">ทุกคน</option>
            {technicians.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">
            สถานะ
          </span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">ทุกสถานะ</option>
            {ASSIGNMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ASSIGNMENT_STATUS_LABELS_TH[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* KPI cards */}
      {kpis.length > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {kpis.map((k) => {
            const below = k.targetWorkValue > 0 && k.targetPercentage < 100;
            return (
              <div
                key={k.technicianId}
                className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm"
              >
                <p className="font-bold text-gray-900">{k.technicianName}</p>
                <p className="text-xs text-gray-500">
                  เป้าหมาย {formatCurrency(k.targetWorkValue)} · มอบแล้ว{" "}
                  {formatCurrency(k.assignedWorkValueToday)}
                </p>
                <div className="mt-2 h-2 w-full rounded-full bg-gray-100">
                  <div
                    className={`h-2 rounded-full ${
                      below ? "bg-amber-400" : "bg-green-600"
                    }`}
                    style={{
                      width: `${Math.min(100, k.targetPercentage)}%`,
                    }}
                  />
                </div>
                <p className="mt-1 text-xs">
                  <span
                    className={
                      below
                        ? "font-bold text-amber-700"
                        : "font-bold text-green-700"
                    }
                  >
                    {k.targetPercentage}% ของเป้า
                  </span>{" "}
                  · งาน {k.assignedJobCount} ชิ้น · เสร็จ {k.completedJobCount}
                </p>
                {below && (
                  <p className="mt-0.5 text-[11px] text-amber-700">
                    ⚠ ต่ำกว่าเป้าค่างานวันนี้
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Assignments */}
      {loading ? (
        <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center text-gray-500">
          กำลังโหลด...
        </div>
      ) : assignments.length === 0 ? (
        <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center text-gray-500">
          ไม่มีงานตามตัวกรอง
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {assignments.map((a) => (
            <div
              key={a.id}
              className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-base font-bold text-gray-900">
                    {a.jobId ?? `#${a.orderId.slice(0, 8).toUpperCase()}`}
                  </p>
                  <p className="text-sm text-gray-800 truncate">
                    {a.customerName || "(ไม่ระบุ)"} · {a.itemName}
                  </p>
                  <p className="text-xs text-gray-500">
                    ช่าง: {a.technicianName} · {formatCurrency(a.price)}
                    {a.dueDate ? ` · กำหนด ${a.dueDate}` : ""}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold ${
                    STATUS_BADGE[a.status] ?? STATUS_BADGE.ASSIGNED
                  }`}
                >
                  {ASSIGNMENT_STATUS_LABELS_TH[a.status as AssignmentStatus] ??
                    a.status}
                </span>
              </div>
              {a.priority !== "NORMAL" && (
                <span className="mt-2 inline-block rounded-full bg-red-50 border border-red-200 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                  {PRIORITY_LABELS_TH[a.priority as AssignmentPriority] ??
                    a.priority}
                </span>
              )}
              {a.adminNote && (
                <p className="mt-1 text-xs text-gray-600">
                  โน้ต: {a.adminNote}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-gray-100 pt-3">
                {a.status === "ASSIGNED" && (
                  <StatusBtn
                    label="เริ่มงาน"
                    busy={busyId === a.id}
                    onClick={() => updateStatus(a.id, "IN_PROGRESS")}
                  />
                )}
                {a.status === "IN_PROGRESS" && (
                  <StatusBtn
                    label="ส่งตรวจ QC"
                    busy={busyId === a.id}
                    onClick={() => updateStatus(a.id, "QC_WAITING")}
                  />
                )}
                {a.status === "QC_WAITING" && (
                  <>
                    <StatusBtn
                      label="ผ่าน — เสร็จ"
                      busy={busyId === a.id}
                      onClick={() => updateStatus(a.id, "DONE")}
                    />
                    <StatusBtn
                      label="ส่งแก้ไข"
                      tone="orange"
                      busy={busyId === a.id}
                      onClick={() => updateStatus(a.id, "REWORK")}
                    />
                  </>
                )}
                {a.status === "REWORK" && (
                  <StatusBtn
                    label="ส่งตรวจ QC อีกครั้ง"
                    busy={busyId === a.id}
                    onClick={() => updateStatus(a.id, "QC_WAITING")}
                  />
                )}
                {a.status !== "DONE" && a.status !== "CANCELLED" && (
                  <StatusBtn
                    label="ยกเลิก"
                    tone="red"
                    busy={busyId === a.id}
                    onClick={() => updateStatus(a.id, "CANCELLED")}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBtn({
  label,
  tone = "green",
  busy,
  onClick,
}: {
  label: string;
  tone?: "green" | "orange" | "red";
  busy: boolean;
  onClick: () => void;
}) {
  const cls =
    tone === "red"
      ? "border-red-300 text-red-700 hover:bg-red-50"
      : tone === "orange"
        ? "border-orange-300 text-orange-800 hover:bg-orange-50"
        : "border-green-600 text-green-700 hover:bg-green-50";
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${cls}`}
    >
      {label}
    </button>
  );
}
