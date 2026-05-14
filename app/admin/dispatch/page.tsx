"use client";

// /admin/dispatch — notification queue monitoring + manual tick trigger.
//
// Sibling to /admin/recovery (which drains sync_failures). This page is
// the operator-facing view onto customer_notifications:
//   • queue depth by status (queued / sending / sent / failed / skipped)
//   • 25 most recent failures with error_reason — spot bad templates fast
//   • next-up preview (queued + sending) ordered by send_after
//   • manual "run tick" button — flushes the queue without waiting for cron
//   • SMS provider env value — confirms which adapter is wired
//
// Owner / hq_admin only (matches the API). Branch managers see this
// through the admin landing but the API will 403 them; the RouteGuard
// at "admin" surfaces the same gate one layer earlier.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";

type Counts = {
  queued: number;
  sending: number;
  sent: number;
  delivered: number;
  failed: number;
  dead_letter: number;
  skipped: number;
  cancelled: number;
};

type FailureRow = {
  id: string;
  channel: string;
  kind: string;
  status: string;
  attempts: number;
  send_after: string;
  sent_at: string | null;
  error_reason: string | null;
  customer_id: string | null;
  branch_id: string | null;
  created_at: string;
};

type PendingRow = {
  id: string;
  channel: string;
  kind: string;
  status: string;
  attempts: number;
  send_after: string;
  customer_id: string | null;
  branch_id: string | null;
  created_at: string;
};

type TickItem = {
  notificationId: string;
  channel: string;
  kind: string;
  succeeded: boolean;
  dead: boolean;
  skipped: boolean;
  retryable: boolean;
  reason?: string;
};

type TickResult = {
  processed: number;
  succeeded: number;
  failed: number;
  dead: number;
  skipped: number;
  items: TickItem[];
  startedAt: string;
  finishedAt: string;
};

type Observability = {
  windowHours: number;
  sampleSize: number;
  sent: number;
  failed: number;
  skipped: number;
  successRate: number | null;
  avgRetryDepth: number;
  providerLatencyMs: { p50: number | null; p95: number | null; samples: number };
  deadLetterTrend: Array<{ hour: string; failed: number; sent: number }>;
  byChannel: Record<
    string,
    { sent: number; failed: number; skipped: number; total: number; successRate: number | null }
  >;
  resends?: { total: number; byAction: Record<string, number> };
  rateLimitTriggers?: { total: number; byBucket: Record<string, number> };
};

type Summary = {
  ok: boolean;
  counts: Counts;
  recentFailures: FailureRow[];
  pendingPreview: PendingRow[];
  smsProvider: string;
  observability?: Observability;
};

function fmt(iso: string | null | undefined): string {
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

const CHANNEL_TONE: Record<string, string> = {
  sms: "border-blue-200 bg-blue-50 text-blue-800",
  line: "border-green-200 bg-green-50 text-green-800",
  email: "border-purple-200 bg-purple-50 text-purple-800",
  in_app: "border-gray-200 bg-gray-50 text-gray-700",
};

const STATUS_TONE: Record<string, string> = {
  queued: "border-yellow-200 bg-yellow-50 text-yellow-800",
  sending: "border-blue-200 bg-blue-50 text-blue-800",
  sent: "border-green-200 bg-green-50 text-green-800",
  delivered: "border-emerald-300 bg-emerald-50 text-emerald-900",
  failed: "border-red-200 bg-red-50 text-red-800",
  dead_letter: "border-red-300 bg-red-100 text-red-900",
  skipped: "border-gray-200 bg-gray-50 text-gray-700",
  cancelled: "border-gray-300 bg-gray-100 text-gray-700",
};

export default function AdminDispatchPage() {
  return (
    <RouteGuard page="admin">
      <DispatchInner />
    </RouteGuard>
  );
}

function DispatchInner() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTick, setLastTick] = useState<TickResult | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/dispatch/summary", {
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        setError("ไม่มีสิทธิ์เข้าถึง — Owner / HQ เท่านั้น");
        setSummary(null);
        return;
      }
      const json = (await res.json()) as Summary & { reason?: string };
      if (!json.ok) {
        setError(json.reason ?? `โหลดข้อมูลล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setSummary(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRun = async (limit: number) => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/dispatch/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit }),
      });
      const json = (await res.json()) as TickResult & {
        ok?: boolean;
        reason?: string;
      };
      if (!json.ok) {
        setError(json.reason ?? `รัน worker ล้มเหลว (HTTP ${res.status})`);
      } else {
        setLastTick(json);
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setRunning(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="h-7 w-1/3 bg-gray-200 rounded animate-pulse" />
          <div className="grid sm:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="h-24 rounded-2xl bg-white border border-gray-100 animate-pulse"
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Dispatch monitor</span>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold text-gray-900">
              Dispatch monitor
            </h1>
            <p className="text-sm text-gray-600">
              คิวข้อความลูกค้า (customer_notifications) — SMS / LINE / Email / In-app
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-700">
              SMS provider:{" "}
              <strong className="text-gray-900">
                {summary?.smsProvider ?? "?"}
              </strong>
            </span>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-4 py-2 text-sm font-semibold text-gray-800"
            >
              รีเฟรช
            </button>
            <button
              type="button"
              onClick={() => void handleRun(25)}
              disabled={running}
              className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {running ? "กำลังรัน..." : "รัน tick (25)"}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {summary && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
              <KpiCard label="Queued" value={summary.counts.queued} tone="yellow" />
              <KpiCard label="Sending" value={summary.counts.sending} tone="blue" />
              <KpiCard label="Sent" value={summary.counts.sent} tone="green" />
              <KpiCard
                label="Delivered"
                value={summary.counts.delivered}
                tone="green"
              />
              <KpiCard
                label="Failed"
                value={summary.counts.failed}
                tone={summary.counts.failed > 0 ? "red" : "gray"}
              />
              <KpiCard
                label="Dead-letter"
                value={summary.counts.dead_letter}
                tone={summary.counts.dead_letter > 0 ? "red" : "gray"}
              />
              <KpiCard label="Skipped" value={summary.counts.skipped} tone="gray" />
              <KpiCard label="Cancelled" value={summary.counts.cancelled} tone="gray" />
            </div>

            {summary.observability && (
              <ObservabilityPanel data={summary.observability} />
            )}

            {lastTick && (
              <div className="rounded-2xl border border-green-200 bg-green-50/60 p-4">
                <p className="text-xs uppercase tracking-widest text-green-800 font-semibold">
                  Last manual tick
                </p>
                <p className="mt-1 text-sm text-gray-800">
                  {fmt(lastTick.startedAt)} → {fmt(lastTick.finishedAt)} —{" "}
                  <strong>{lastTick.processed}</strong> processed (
                  <span className="text-green-700">{lastTick.succeeded} ok</span>
                  {" · "}
                  <span className="text-red-700">{lastTick.failed} retry</span>
                  {" · "}
                  <span className="text-red-900">{lastTick.dead} dead</span>
                  {" · "}
                  <span className="text-gray-700">{lastTick.skipped} skipped</span>
                  )
                </p>
                {lastTick.items.length > 0 && (
                  <details className="mt-2">
                    <summary className="text-xs text-gray-600 cursor-pointer">
                      ดูรายละเอียดแต่ละแถว ({lastTick.items.length})
                    </summary>
                    <ul className="mt-2 space-y-1 text-xs text-gray-700">
                      {lastTick.items.map((it) => (
                        <li key={it.notificationId || `${it.channel}-${it.kind}`}>
                          <code className="text-[10px] text-gray-500">
                            {it.notificationId.slice(0, 8) || "—"}
                          </code>{" "}
                          {it.channel}/{it.kind} —{" "}
                          {it.succeeded
                            ? "ok"
                            : it.dead
                            ? `dead: ${it.reason ?? "no reason"}`
                            : it.skipped
                            ? `skipped: ${it.reason ?? "no reason"}`
                            : `retry: ${it.reason ?? "no reason"}`}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            <section className="rounded-2xl border border-gray-200 bg-white">
              <div className="p-4 border-b border-gray-100">
                <h2 className="text-lg font-bold text-gray-900">
                  ความล้มเหลวล่าสุด (failed)
                </h2>
                <p className="text-xs text-gray-500">
                  25 รายการล่าสุดที่ status = failed
                </p>
              </div>
              {summary.recentFailures.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-500">
                  ✓ ไม่มีรายการที่ล้มเหลว
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr className="text-left text-xs text-gray-600">
                        <Th>Channel</Th>
                        <Th>Kind</Th>
                        <Th>Attempts</Th>
                        <Th>Created</Th>
                        <Th>Branch</Th>
                        <Th>Error</Th>
                        <Th>Action</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {summary.recentFailures.map((row) => (
                        <tr key={row.id} className="hover:bg-gray-50">
                          <Td>
                            <Pill
                              text={row.channel}
                              tone={CHANNEL_TONE[row.channel] ?? CHANNEL_TONE.in_app}
                            />
                          </Td>
                          <Td className="font-mono text-xs">{row.kind}</Td>
                          <Td className="text-xs text-gray-700">
                            {row.attempts}
                          </Td>
                          <Td className="text-xs text-gray-700">
                            {fmt(row.created_at)}
                          </Td>
                          <Td className="text-xs text-gray-700">
                            {row.branch_id ?? "—"}
                          </Td>
                          <Td className="text-xs text-red-700 max-w-md truncate">
                            {row.error_reason ?? "—"}
                          </Td>
                          <Td>
                            <ResendButton
                              notificationId={row.id}
                              onDone={() => void load()}
                            />
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-gray-200 bg-white">
              <div className="p-4 border-b border-gray-100">
                <h2 className="text-lg font-bold text-gray-900">
                  รอส่ง / กำลังส่ง
                </h2>
                <p className="text-xs text-gray-500">
                  25 รายการแรกที่จะถูกประมวลผลในรอบถัดไป
                </p>
              </div>
              {summary.pendingPreview.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-500">
                  ไม่มีรายการรอ
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr className="text-left text-xs text-gray-600">
                        <Th>Channel</Th>
                        <Th>Kind</Th>
                        <Th>Status</Th>
                        <Th>Send after</Th>
                        <Th>Attempts</Th>
                        <Th>Branch</Th>
                        <Th>Action</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {summary.pendingPreview.map((row) => (
                        <tr key={row.id} className="hover:bg-gray-50">
                          <Td>
                            <Pill
                              text={row.channel}
                              tone={CHANNEL_TONE[row.channel] ?? CHANNEL_TONE.in_app}
                            />
                          </Td>
                          <Td className="font-mono text-xs">{row.kind}</Td>
                          <Td>
                            <Pill
                              text={row.status}
                              tone={STATUS_TONE[row.status] ?? STATUS_TONE.queued}
                            />
                          </Td>
                          <Td className="text-xs text-gray-700">
                            {fmt(row.send_after)}
                          </Td>
                          <Td className="text-xs text-gray-700">
                            {row.attempts}
                          </Td>
                          <Td className="text-xs text-gray-700">
                            {row.branch_id ?? "—"}
                          </Td>
                          <Td>
                            <CancelButton
                              notificationId={row.id}
                              onDone={() => void load()}
                            />
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function ObservabilityPanel({ data }: { data: Observability }) {
  const successColor =
    data.successRate == null
      ? "text-gray-500"
      : data.successRate >= 95
      ? "text-green-700"
      : data.successRate >= 80
      ? "text-amber-700"
      : "text-red-700";
  const maxBucket = Math.max(
    1,
    ...data.deadLetterTrend.map((b) => Math.max(b.failed, b.sent))
  );
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900">
            Observability (24h)
          </h2>
          <p className="text-[11px] text-gray-500">
            sample: {data.sampleSize} attempts · {data.sent} sent ·{" "}
            {data.failed} failed · {data.skipped} skipped
          </p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
          <dt className="text-[10px] uppercase tracking-widest text-gray-500">
            Success rate
          </dt>
          <dd className={`mt-0.5 text-xl font-extrabold ${successColor}`}>
            {data.successRate == null ? "—" : `${data.successRate}%`}
          </dd>
        </div>
        <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
          <dt className="text-[10px] uppercase tracking-widest text-gray-500">
            Avg retry depth
          </dt>
          <dd className="mt-0.5 text-xl font-extrabold text-gray-900">
            {data.avgRetryDepth}
          </dd>
          <div className="text-[10px] text-gray-500">
            attempts per failure
          </div>
        </div>
        <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
          <dt className="text-[10px] uppercase tracking-widest text-gray-500">
            Provider p50
          </dt>
          <dd className="mt-0.5 text-xl font-extrabold text-gray-900">
            {data.providerLatencyMs.p50 != null
              ? `${data.providerLatencyMs.p50}ms`
              : "—"}
          </dd>
          <div className="text-[10px] text-gray-500">
            n={data.providerLatencyMs.samples}
          </div>
        </div>
        <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
          <dt className="text-[10px] uppercase tracking-widest text-gray-500">
            Provider p95
          </dt>
          <dd className="mt-0.5 text-xl font-extrabold text-gray-900">
            {data.providerLatencyMs.p95 != null
              ? `${data.providerLatencyMs.p95}ms`
              : "—"}
          </dd>
        </div>
      </div>

      <div className="mt-4">
        <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
          Trend (per hour) — green=sent · red=failed
        </p>
        <div
          className="mt-2 grid gap-0.5 h-16"
          style={{
            gridTemplateColumns: "repeat(24, minmax(0, 1fr))",
          }}
        >
          {data.deadLetterTrend.map((b, i) => {
            const sentHeight = (b.sent / maxBucket) * 100;
            const failedHeight = (b.failed / maxBucket) * 100;
            return (
              <div
                key={`${b.hour}-${i}`}
                className="flex flex-col-reverse"
                title={`${b.hour}: ${b.sent} sent · ${b.failed} failed`}
              >
                <div
                  className="bg-green-500 rounded-t-sm"
                  style={{ height: `${sentHeight}%` }}
                />
                <div
                  className="bg-red-500 rounded-t-sm"
                  style={{ height: `${failedHeight}%` }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {(data.resends || data.rateLimitTriggers) && (
        <div className="mt-4 grid sm:grid-cols-2 gap-3">
          {data.resends && (
            <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
              <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
                Resends (24h)
              </p>
              <p className="mt-0.5 text-xl font-extrabold text-gray-900">
                {data.resends.total}
              </p>
              <div className="text-[10px] text-gray-600">
                {Object.entries(data.resends.byAction)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ") || "—"}
              </div>
            </div>
          )}
          {data.rateLimitTriggers && (
            <div
              className={`rounded-xl border px-3 py-2 ${
                data.rateLimitTriggers.total > 0
                  ? "border-amber-200 bg-amber-50"
                  : "border-gray-100 bg-gray-50"
              }`}
            >
              <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
                Rate-limit triggers (24h)
              </p>
              <p
                className={`mt-0.5 text-xl font-extrabold ${
                  data.rateLimitTriggers.total > 0
                    ? "text-amber-800"
                    : "text-gray-900"
                }`}
              >
                {data.rateLimitTriggers.total}
              </p>
              <div className="text-[10px] text-gray-700">
                {Object.entries(data.rateLimitTriggers.byBucket)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ") || "—"}
              </div>
            </div>
          )}
        </div>
      )}

      {Object.keys(data.byChannel).length > 0 && (
        <div className="mt-4">
          <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
            Per channel
          </p>
          <div className="mt-2 grid sm:grid-cols-2 gap-2">
            {Object.entries(data.byChannel).map(([ch, s]) => (
              <div
                key={ch}
                className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 flex items-center justify-between"
              >
                <div>
                  <div className="text-sm font-semibold text-gray-900">
                    {ch.toUpperCase()}
                  </div>
                  <div className="text-[10px] text-gray-500">
                    {s.total} total · {s.sent} sent · {s.failed} failed ·{" "}
                    {s.skipped} skipped
                  </div>
                </div>
                <div
                  className={`text-lg font-extrabold ${
                    s.successRate == null
                      ? "text-gray-500"
                      : s.successRate >= 95
                      ? "text-green-700"
                      : s.successRate >= 80
                      ? "text-amber-700"
                      : "text-red-700"
                  }`}
                >
                  {s.successRate == null ? "—" : `${s.successRate}%`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function KpiCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "yellow" | "blue" | "green" | "red" | "gray";
}) {
  const bar =
    tone === "yellow"
      ? "from-yellow-50 to-amber-50 text-amber-900 border-yellow-200"
      : tone === "blue"
      ? "from-blue-50 to-sky-50 text-blue-900 border-blue-200"
      : tone === "green"
      ? "from-green-50 to-emerald-50 text-green-900 border-green-200"
      : tone === "red"
      ? "from-red-50 to-rose-50 text-red-900 border-red-200"
      : "from-gray-50 to-slate-50 text-gray-800 border-gray-200";
  return (
    <div
      className={`rounded-2xl border bg-gradient-to-br ${bar} p-4`}
    >
      <p className="text-[10px] uppercase tracking-widest font-semibold opacity-80">
        {label}
      </p>
      <p className="mt-1 text-2xl font-extrabold">{value}</p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 font-semibold uppercase tracking-wider text-[10px]">
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 ${className ?? ""}`}>{children}</td>;
}

function Pill({ text, tone }: { text: string; tone: string }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone}`}
    >
      {text}
    </span>
  );
}

function ResendButton({
  notificationId,
  onDone,
}: {
  notificationId: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const handle = async () => {
    if (busy) return;
    const reason =
      window.prompt("เหตุผลในการส่งซ้ำ (optional)") ?? null;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/notifications/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationId, reason }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        window.alert(`ส่งซ้ำไม่สำเร็จ: ${json.reason ?? `HTTP ${res.status}`}`);
      } else {
        onDone();
      }
    } catch (err) {
      window.alert(
        `ส่งซ้ำไม่สำเร็จ: ${err instanceof Error ? err.message : "Network error"}`
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={handle}
      disabled={busy}
      className="rounded-md border border-green-200 bg-green-50 hover:bg-green-100 text-green-800 px-2 py-1 text-[10px] font-semibold disabled:opacity-50"
    >
      {busy ? "กำลังส่ง..." : "ส่งซ้ำ"}
    </button>
  );
}

function CancelButton({
  notificationId,
  onDone,
}: {
  notificationId: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const handle = async () => {
    if (busy) return;
    if (!window.confirm("ยกเลิกข้อความนี้ก่อนส่ง?")) return;
    const reason = window.prompt("เหตุผล (optional)") ?? null;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/notifications/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationId, reason }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        window.alert(`ยกเลิกไม่สำเร็จ: ${json.reason ?? `HTTP ${res.status}`}`);
      } else {
        onDone();
      }
    } catch (err) {
      window.alert(
        `ยกเลิกไม่สำเร็จ: ${err instanceof Error ? err.message : "Network error"}`
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={handle}
      disabled={busy}
      className="rounded-md border border-red-200 bg-red-50 hover:bg-red-100 text-red-800 px-2 py-1 text-[10px] font-semibold disabled:opacity-50"
    >
      {busy ? "..." : "ยกเลิก"}
    </button>
  );
}
