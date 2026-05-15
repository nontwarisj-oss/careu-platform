"use client";

// /admin/crm/broadcasts/[id]/jobs/[jobId] — single broadcast send_job
// monitoring page.
//
// Shows progress, channel breakdown, recent attempts (fan-out ticks),
// per-day metrics, and a sample of recently dispatched targets. Pause
// / resume / cancel buttons appear when the status allows them.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { usePortalRefresh } from "@/lib/usePortalRefresh";

type Job = {
  id: string;
  status: string;
  mode: string;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  paused_at: string | null;
  cancelled_at: string | null;
  expected_total: number | null;
  channels: string[];
  failure_reason: string | null;
  created_at: string;
};

type Counts = {
  pending: number;
  dispatched: number;
  skipped: number;
  dead_letter: number;
};

type ChannelBreakdown = Record<
  string,
  { dispatched: number; skipped: number; pending: number }
>;

type Attempt = {
  id: string;
  targets_processed: number;
  dispatched_count: number;
  skipped_count: number;
  failed_count: number;
  blocked_reason: string | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
};

type MetricRow = {
  metric_date: string;
  channel: string;
  sent_count: number;
  skipped_count: number;
  deduped_count: number;
  opted_out_count: number;
  delivered_count: number;
  failed_count: number;
};

type SampleRow = {
  id: string;
  customer_id: string;
  channel: string;
  status: string;
  skip_reason: string | null;
  notification_id: string | null;
  processed_at: string | null;
};

type PageData = {
  job: Job;
  counts: Counts;
  channelBreakdown: ChannelBreakdown;
  attempts: Attempt[];
  metrics: MetricRow[];
  sample: SampleRow[];
};

const STATUS_TONE: Record<string, string> = {
  queued: "border-yellow-200 bg-yellow-50 text-yellow-800",
  processing: "border-blue-200 bg-blue-50 text-blue-900",
  paused: "border-amber-200 bg-amber-50 text-amber-900",
  completed: "border-green-200 bg-green-50 text-green-800",
  cancelled: "border-gray-300 bg-gray-100 text-gray-700",
  failed: "border-red-200 bg-red-50 text-red-800",
};

const STATUS_LABEL: Record<string, string> = {
  queued: "รอเริ่ม",
  processing: "กำลังส่ง",
  paused: "หยุดชั่วคราว",
  completed: "เสร็จสิ้น",
  cancelled: "ยกเลิก",
  failed: "ล้มเหลว",
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("th-TH", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export default function JobDetailPage() {
  return (
    <RouteGuard page="admin">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const params = useParams<{ id: string; jobId: string }>();
  const draftId = params?.id;
  const jobId = params?.jobId;
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!draftId || !jobId) return;
    try {
      const res = await fetch(
        `/api/admin/crm/broadcasts/${draftId}/jobs/${jobId}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as PageData & {
        ok?: boolean;
        reason?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `โหลดล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [draftId, jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live refresh — 10 s while processing, slower while queued/paused.
  // Stops polling once terminal.
  const terminal = data?.job.status === "completed" || data?.job.status === "cancelled" || data?.job.status === "failed";
  usePortalRefresh(load, {
    intervalMs: terminal ? 60_000 : data?.job.status === "processing" ? 8_000 : 20_000,
    fireOnMount: false,
  });

  const handleAction = async (action: "pause" | "resume" | "cancel") => {
    if (!draftId || !jobId) return;
    if (action === "cancel" && !window.confirm("ยกเลิก job นี้ — pending targets จะถูก skip ทันที?")) {
      return;
    }
    setBusyAction(action);
    try {
      const reason = window.prompt(`เหตุผลสำหรับ ${action} (optional)`) ?? null;
      const res = await fetch(
        `/api/admin/crm/broadcasts/${draftId}/jobs/${jobId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, reason }),
        }
      );
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        window.alert(`${action} ไม่สำเร็จ: ${json.reason ?? `HTTP ${res.status}`}`);
      } else {
        await load();
      }
    } catch (err) {
      window.alert(
        `${action} ไม่สำเร็จ: ${err instanceof Error ? err.message : "Network error"}`
      );
    } finally {
      setBusyAction(null);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-gray-500">โหลด...</div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-8 max-w-md mx-auto">
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? "ไม่พบ job"}
          <div className="mt-3">
            <Link
              href={`/admin/crm/broadcasts/${draftId}`}
              className="text-green-700 underline"
            >
              กลับไป draft
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const job = data.job;
  const totalProcessed =
    data.counts.dispatched + data.counts.skipped + data.counts.dead_letter;
  const total = job.expected_total ?? 0;
  const progressPct = total > 0 ? Math.round((totalProcessed / total) * 100) : 0;

  const canPause = job.status === "queued" || job.status === "processing";
  const canResume = job.status === "paused";
  const canCancel =
    job.status === "queued" || job.status === "processing" || job.status === "paused";

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <Link href="/admin/crm/broadcasts" className="hover:text-green-700">
            CRM
          </Link>
          <span>/</span>
          <Link
            href={`/admin/crm/broadcasts/${draftId}`}
            className="hover:text-green-700"
          >
            Draft
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium font-mono">
            #{job.id.slice(0, 8)}
          </span>
        </div>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-extrabold text-gray-900">
                Send job <span className="font-mono">#{job.id.slice(0, 8)}</span>
              </h1>
              <p className="mt-1 text-xs text-gray-500">
                สร้าง {fmt(job.created_at)}{" · "}
                {job.scheduled_for
                  ? `ตั้งเวลา ${fmt(job.scheduled_for)}`
                  : "ส่งทันที"}
                {" · "}
                {job.mode === "dry_run" ? "dry-run (ไม่ส่งจริง)" : "live"}
              </p>
              <Link
                href={`/admin/system/delivery-trace?broadcastJobId=${job.id}`}
                className="mt-1 inline-block text-[11px] font-semibold text-green-700 hover:text-green-900 underline"
              >
                ดู delivery trace ของ campaign นี้ →
              </Link>
            </div>
            <span
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                STATUS_TONE[job.status] ?? STATUS_TONE.queued
              }`}
            >
              {STATUS_LABEL[job.status] ?? job.status}
            </span>
          </div>

          {job.failure_reason && (
            <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {job.failure_reason}
            </div>
          )}

          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-gray-600">
              <span>
                {totalProcessed.toLocaleString()} / {total.toLocaleString()} เป้าหมาย
              </span>
              <span>{progressPct}%</span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full ${
                  job.status === "completed"
                    ? "bg-green-500"
                    : job.status === "cancelled" || job.status === "failed"
                      ? "bg-red-400"
                      : "bg-blue-500"
                }`}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <KPI label="Dispatched" value={data.counts.dispatched} tone="green" />
            <KPI label="Pending" value={data.counts.pending} tone="amber" />
            <KPI label="Skipped" value={data.counts.skipped} tone="gray" />
            <KPI label="Dead-letter" value={data.counts.dead_letter} tone="red" />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canPause || busyAction !== null}
              onClick={() => void handleAction("pause")}
              className="rounded-xl border border-amber-200 bg-amber-50 hover:bg-amber-100 text-amber-900 px-3 py-2 text-xs font-semibold disabled:opacity-50"
            >
              {busyAction === "pause" ? "..." : "Pause"}
            </button>
            <button
              type="button"
              disabled={!canResume || busyAction !== null}
              onClick={() => void handleAction("resume")}
              className="rounded-xl border border-green-200 bg-green-50 hover:bg-green-100 text-green-800 px-3 py-2 text-xs font-semibold disabled:opacity-50"
            >
              {busyAction === "resume" ? "..." : "Resume"}
            </button>
            <button
              type="button"
              disabled={!canCancel || busyAction !== null}
              onClick={() => void handleAction("cancel")}
              className="rounded-xl border border-red-200 bg-red-50 hover:bg-red-100 text-red-800 px-3 py-2 text-xs font-semibold disabled:opacity-50"
            >
              {busyAction === "cancel" ? "..." : "Cancel"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700"
            >
              รีเฟรช
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-bold text-gray-900">แยกตามช่องทาง</h2>
          <div className="mt-3 grid sm:grid-cols-2 gap-3">
            {Object.entries(data.channelBreakdown).map(([ch, c]) => (
              <div
                key={ch}
                className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-900">
                    {ch.toUpperCase()}
                  </span>
                  <span className="text-[10px] text-gray-500">
                    {c.dispatched + c.skipped + c.pending} ทั้งหมด
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-gray-700 space-x-2">
                  <span className="text-green-700">
                    ส่งแล้ว {c.dispatched}
                  </span>
                  <span className="text-gray-500">ข้าม {c.skipped}</span>
                  <span className="text-amber-700">เหลือ {c.pending}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-bold text-gray-900">
            Fan-out ticks (20 ล่าสุด)
          </h2>
          {data.attempts.length === 0 ? (
            <p className="mt-3 text-xs text-gray-500">ยังไม่มี tick</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-[10px] uppercase tracking-wider text-gray-600">
                  <tr>
                    <th className="px-2 py-1.5">เวลา</th>
                    <th className="px-2 py-1.5">processed</th>
                    <th className="px-2 py-1.5">dispatched</th>
                    <th className="px-2 py-1.5">skipped</th>
                    <th className="px-2 py-1.5">duration</th>
                    <th className="px-2 py-1.5">blocked</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.attempts.map((a) => (
                    <tr key={a.id}>
                      <td className="px-2 py-1.5 text-xs text-gray-700">
                        {fmt(a.started_at)}
                      </td>
                      <td className="px-2 py-1.5 text-xs">{a.targets_processed}</td>
                      <td className="px-2 py-1.5 text-xs text-green-700">
                        {a.dispatched_count}
                      </td>
                      <td className="px-2 py-1.5 text-xs text-gray-600">
                        {a.skipped_count}
                      </td>
                      <td className="px-2 py-1.5 text-xs">
                        {a.duration_ms != null ? `${a.duration_ms}ms` : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-xs text-amber-700 max-w-xs truncate">
                        {a.blocked_reason ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-bold text-gray-900">
            Sample (20 รายการล่าสุด)
          </h2>
          {data.sample.length === 0 ? (
            <p className="mt-3 text-xs text-gray-500">ยังไม่มี target</p>
          ) : (
            <ul className="mt-3 divide-y divide-gray-100 text-xs">
              {data.sample.map((s) => (
                <li
                  key={s.id}
                  className="py-1.5 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-mono text-[10px] text-gray-500">
                      {s.customer_id.slice(0, 8)}
                    </span>
                    <span className="ml-2">{s.channel.toUpperCase()}</span>
                    {s.skip_reason && (
                      <span className="ml-2 text-gray-500 truncate">
                        — {s.skip_reason}
                      </span>
                    )}
                  </div>
                  <span
                    className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
                      s.status === "dispatched"
                        ? "border-green-200 bg-green-50 text-green-800"
                        : s.status === "skipped"
                          ? "border-gray-200 bg-gray-50 text-gray-700"
                          : "border-red-200 bg-red-50 text-red-800"
                    }`}
                  >
                    {s.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function KPI({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "green" | "amber" | "red" | "gray";
}) {
  const valueClass =
    tone === "green"
      ? "text-green-700"
      : tone === "red"
        ? "text-red-700"
        : tone === "amber"
          ? "text-amber-800"
          : "text-gray-900";
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
        {label}
      </p>
      <p className={`mt-0.5 text-lg font-extrabold ${valueClass}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}
