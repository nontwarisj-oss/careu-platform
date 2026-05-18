"use client";

// Phase J — /technician/my-jobs. Mobile-first technician job view.
//
// TODO (technician auth mapping): there is no technician LINE login yet,
// so this page is admin-accessible (RouteGuard page="admin") with a
// technician picker. Once a technician → auth identity mapping is wired,
// drop the picker and scope to the signed-in technician.

import { useCallback, useEffect, useState } from "react";
import { RouteGuard } from "@/components/RouteGuard";
import { formatCurrency } from "@/lib/utils";
import {
  ASSIGNMENT_STATUS_LABELS_TH,
  type AssignmentStatus,
} from "@/lib/productionQueue";

type Job = {
  id: string;
  orderId: string;
  jobId: string | null;
  customerName: string;
  itemName: string;
  price: number;
  dueDate: string | null;
  status: string;
  adminNote: string | null;
  technicianNote: string | null;
};
type TechOption = { id: string; displayName: string };

export default function MyJobsPage() {
  return (
    <RouteGuard page="admin">
      <MyJobsInner />
    </RouteGuard>
  );
}

function MyJobsInner() {
  const [technicianId, setTechnicianId] = useState("");
  const [technicians, setTechnicians] = useState<TechOption[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ open: "1" });
      if (technicianId) params.set("technicianId", technicianId);
      const res = await fetch(`/api/production/assignments?${params}`);
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        assignments?: Job[];
        technicians?: TechOption[];
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `โหลดไม่สำเร็จ (HTTP ${res.status})`);
      } else {
        setTechnicians(json.technicians ?? []);
        setJobs(technicianId ? json.assignments ?? [] : []);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "โหลดงานไม่สำเร็จ");
    }
    setLoading(false);
  }, [technicianId]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = async (
    id: string,
    patch: { status?: AssignmentStatus; technicianNote?: string }
  ) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch("/api/production/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", assignmentId: id, ...patch }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) setError(json.error ?? "อัปเดตไม่สำเร็จ");
      else {
        setNoteOpen(null);
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "อัปเดตไม่สำเร็จ");
    }
    setBusyId(null);
  };

  return (
    <div className="flex-1 min-h-screen bg-gray-50 px-4 pt-20 pb-10">
      <div className="mx-auto w-full max-w-md space-y-4">
        <div className="border-l-4 border-yellow-400 pl-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS
          </p>
          <h1 className="text-2xl font-extrabold text-gray-900">งานของช่าง</h1>
          <p className="text-xs text-gray-500">
            เลือกชื่อช่างเพื่อดูงานที่ได้รับมอบหมาย
          </p>
        </div>

        <select
          value={technicianId}
          onChange={(e) => setTechnicianId(e.target.value)}
          className="w-full rounded-2xl border border-gray-300 p-4 text-base outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="">— เลือกช่าง —</option>
          {technicians.map((t) => (
            <option key={t.id} value={t.id}>
              {t.displayName}
            </option>
          ))}
        </select>

        {error && (
          <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <p className="py-8 text-center text-gray-500">กำลังโหลด...</p>
        ) : !technicianId ? (
          <p className="py-8 text-center text-gray-500">
            เลือกชื่อช่างด้านบนก่อน
          </p>
        ) : jobs.length === 0 ? (
          <p className="py-8 text-center text-gray-500">
            ไม่มีงานค้างของช่างคนนี้
          </p>
        ) : (
          jobs.map((job) => (
            <div
              key={job.id}
              className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-mono text-lg font-extrabold text-gray-900">
                  {job.jobId ?? `#${job.orderId.slice(0, 8).toUpperCase()}`}
                </p>
                <span className="rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 text-[11px] font-bold text-blue-800">
                  {ASSIGNMENT_STATUS_LABELS_TH[
                    job.status as AssignmentStatus
                  ] ?? job.status}
                </span>
              </div>
              <p className="mt-1 text-sm font-medium text-gray-800">
                {job.customerName || "(ไม่ระบุลูกค้า)"}
              </p>
              <p className="text-sm text-gray-600">{job.itemName}</p>
              <p className="mt-1 text-xs text-gray-500">
                มูลค่างาน {formatCurrency(job.price)}
                {job.dueDate ? ` · กำหนดรับ ${job.dueDate}` : ""}
              </p>
              <a
                href={`/orders/${job.orderId}/document`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-xs font-semibold text-green-700 underline"
              >
                ดูใบงาน / รูปงาน →
              </a>
              {job.adminNote && (
                <p className="mt-2 rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-2 text-xs text-yellow-800">
                  โน้ตจากแอดมิน: {job.adminNote}
                </p>
              )}
              {job.technicianNote && (
                <p className="mt-1 text-xs text-gray-500">
                  หมายเหตุช่าง: {job.technicianNote}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2 border-t border-gray-100 pt-3">
                {job.status === "ASSIGNED" && (
                  <BigBtn
                    label="▶ เริ่มงาน"
                    busy={busyId === job.id}
                    onClick={() => update(job.id, { status: "IN_PROGRESS" })}
                  />
                )}
                {job.status === "IN_PROGRESS" && (
                  <BigBtn
                    label="✓ ส่งตรวจ QC"
                    busy={busyId === job.id}
                    onClick={() => update(job.id, { status: "QC_WAITING" })}
                  />
                )}
                {job.status === "REWORK" && (
                  <BigBtn
                    label="✓ ส่งตรวจ QC อีกครั้ง"
                    busy={busyId === job.id}
                    onClick={() => update(job.id, { status: "QC_WAITING" })}
                  />
                )}
                <button
                  type="button"
                  onClick={() => {
                    setNoteOpen(noteOpen === job.id ? null : job.id);
                    setNoteText(job.technicianNote ?? "");
                  }}
                  className="rounded-xl border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-600 active:bg-gray-50"
                >
                  เพิ่มหมายเหตุ
                </button>
              </div>

              {noteOpen === job.id && (
                <div className="mt-2">
                  <textarea
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    rows={2}
                    placeholder="หมายเหตุถึงแอดมิน / QC"
                    className="w-full rounded-xl border border-gray-300 p-3 text-sm outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <button
                    type="button"
                    disabled={busyId === job.id}
                    onClick={() =>
                      update(job.id, { technicianNote: noteText })
                    }
                    className="mt-1 rounded-xl bg-green-700 px-4 py-2 text-sm font-bold text-white active:bg-green-800 disabled:opacity-50"
                  >
                    บันทึกหมายเหตุ
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function BigBtn({
  label,
  busy,
  onClick,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="rounded-xl bg-green-700 px-4 py-2 text-sm font-bold text-white active:bg-green-800 disabled:opacity-50"
    >
      {label}
    </button>
  );
}
