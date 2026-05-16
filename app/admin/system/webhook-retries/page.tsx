"use client";

// /admin/system/webhook-retries — webhook retry / dead-letter
// explorer + replay console.
//
// Phase 26. Lists webhook_retry_queue: pending / retrying /
// dead_letter / succeeded. Each row shows the retry history, the
// terminal reason, and the normalized provider payload. owner / HQ
// can replay any row (including dead-letter).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";

type RetryRow = {
  id: string;
  provider: string;
  event_id: string | null;
  receipt: Record<string, unknown>;
  branch_id: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
  last_error: string | null;
  terminal_reason: string | null;
  created_at: string;
  updated_at: string;
};

const STATUS_TONE: Record<string, string> = {
  pending: "border-blue-300 bg-blue-50 text-blue-800",
  retrying: "border-amber-300 bg-amber-50 text-amber-900",
  dead_letter: "border-red-300 bg-red-100 text-red-900",
  succeeded: "border-green-300 bg-green-50 text-green-800",
};

const STATUSES = ["", "pending", "retrying", "dead_letter", "succeeded"];
const PROVIDERS = ["", "twilio", "resend", "line"];

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

export default function WebhookRetriesPage() {
  return (
    <RouteGuard page="recovery">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const [rows, setRows] = useState<RetryRow[]>([]);
  const [status, setStatus] = useState("");
  const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (provider) params.set("provider", provider);
      const res = await fetch(
        `/api/admin/system/webhook-retries?${params.toString()}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as {
        ok?: boolean;
        rows?: RetryRow[];
        reason?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      setRows(json.rows ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [status, provider]);

  useEffect(() => {
    void load();
  }, [load]);

  const replay = async (id: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/system/webhook-retries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "replay", id }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        applied?: string[];
      };
      if (!json.ok) {
        window.alert(json.reason ?? "replay ล้มเหลว");
      } else {
        setMessage(
          `Replay สำเร็จ — applied: ${(json.applied ?? []).join(", ") || "—"}`
        );
      }
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  const counts = rows.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <Link href="/admin/system/workers" className="hover:text-green-700">
            System
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Webhook retries</span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold text-gray-900">
              Webhook retry &amp; dead-letter
            </h1>
            <p className="text-xs text-gray-500">
              provider callback ที่ประมวลผลล้มเหลว — retry อัตโนมัติทุก ~10
              นาที, replay ได้เอง
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700 disabled:opacity-50"
          >
            รีเฟรช
          </button>
        </div>

        {message && (
          <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
            {message}
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <section className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-[11px] font-semibold text-gray-700">
                สถานะ
              </span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="mt-1 block rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s || "(ทั้งหมด)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-gray-700">
                Provider
              </span>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="mt-1 block rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p || "(ทั้งหมด)"}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-1 text-[10px]">
              {(["pending", "retrying", "dead_letter", "succeeded"] as const).map(
                (s) => (
                  <span
                    key={s}
                    className={`rounded-full border px-2 py-0.5 font-semibold ${STATUS_TONE[s]}`}
                  >
                    {s} {counts[s] ?? 0}
                  </span>
                )
              )}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white">
          {loading ? (
            <p className="p-4 text-sm text-gray-500">โหลด...</p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-500">
              ✓ ไม่มี webhook ที่ค้างใน retry queue
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {rows.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-gray-700">
                          {r.provider}
                        </span>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                            STATUS_TONE[r.status] ?? STATUS_TONE.pending
                          }`}
                        >
                          {r.status}
                        </span>
                        <span className="text-[10px] text-gray-500">
                          attempt {r.attempts}/{r.max_attempts}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-gray-500">
                        {r.event_id ? `event ${r.event_id} · ` : ""}
                        next retry {fmt(r.next_retry_at)} ·{" "}
                        {r.branch_id ?? "—"}
                      </div>
                      {r.last_error && (
                        <div className="mt-0.5 text-[11px] text-red-700">
                          ⚠ {r.last_error}
                        </div>
                      )}
                      {r.terminal_reason && (
                        <div className="mt-0.5 text-[11px] text-red-800 font-semibold">
                          dead-letter: {r.terminal_reason}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded(expanded === r.id ? null : r.id)
                        }
                        className="rounded-md border border-gray-200 bg-gray-50 hover:bg-gray-100 px-2 py-1 text-[11px] font-semibold text-gray-700"
                      >
                        {expanded === r.id ? "ซ่อน" : "payload"}
                      </button>
                      {r.status !== "succeeded" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void replay(r.id)}
                          className="rounded-md border border-green-200 bg-green-50 hover:bg-green-100 px-2 py-1 text-[11px] font-semibold text-green-800 disabled:opacity-50"
                        >
                          Replay
                        </button>
                      )}
                    </div>
                  </div>
                  {expanded === r.id && (
                    <pre className="mt-2 overflow-x-auto rounded-lg bg-gray-900 p-3 text-[10px] leading-relaxed text-gray-100">
                      {JSON.stringify(r.receipt, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
