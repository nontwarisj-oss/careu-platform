"use client";

// /admin/system/delivery-trace — operator delivery trace explorer.
//
// Phase 25. Search every notification by provider message id,
// customer id, phone, status, or campaign. Each result expands to
// the full delivery audit trail (<DeliveryTimeline>).

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { DeliveryTimeline } from "@/components/DeliveryTimeline";

type Result = {
  id: string;
  customer_id: string | null;
  branch_id: string | null;
  channel: string;
  kind: string;
  status: string;
  attempts: number;
  provider_message_id: string | null;
  last_provider_status: string | null;
  error_reason: string | null;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
};

const STATUSES = [
  "",
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed",
  "dead_letter",
  "cancelled",
];

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

export default function DeliveryTracePage() {
  return (
    <RouteGuard page="recovery">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const [q, setQ] = useState("");
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState("");
  const [broadcastJobId, setBroadcastJobId] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const searchWith = useCallback(
    async (filters: {
      q?: string;
      phone?: string;
      status?: string;
      broadcastJobId?: string;
    }) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.q?.trim()) params.set("q", filters.q.trim());
      if (filters.phone?.trim()) params.set("phone", filters.phone.trim());
      if (filters.status) params.set("status", filters.status);
      if (filters.broadcastJobId?.trim())
        params.set("broadcastJobId", filters.broadcastJobId.trim());
      const res = await fetch(
        `/api/admin/system/delivery-trace?${params.toString()}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        results?: Result[];
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      setResults(json.results ?? []);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  const search = useCallback(
    () => searchWith({ q, phone, status, broadcastJobId }),
    [searchWith, q, phone, status, broadcastJobId]
  );

  // Deep-link: a ?broadcastJobId= param (e.g. from the campaign job
  // page) pre-fills the filter and runs the search once.
  const didDeepLink = useRef(false);
  useEffect(() => {
    if (didDeepLink.current) return;
    didDeepLink.current = true;
    const params = new URLSearchParams(window.location.search);
    const job = params.get("broadcastJobId") ?? "";
    if (job) {
      setBroadcastJobId(job);
      void searchWith({ broadcastJobId: job });
    }
  }, [searchWith]);

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
          <span className="text-gray-700 font-medium">Delivery trace</span>
        </div>

        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">
            Delivery trace explorer
          </h1>
          <p className="text-xs text-gray-500">
            ค้นหาข้อความตาม provider id / customer id / เบอร์โทร / สถานะ /
            campaign — แล้วกดดู timeline ฉบับเต็ม
          </p>
        </div>

        <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field
              label="Provider message id / customer id"
              value={q}
              onChange={setQ}
              placeholder="SMxxxx… หรือ customer uuid"
            />
            <Field
              label="เบอร์โทร"
              value={phone}
              onChange={setPhone}
              placeholder="08x-xxx-xxxx"
            />
            <label className="block">
              <span className="text-[11px] font-semibold text-gray-700">
                สถานะ
              </span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s || "(ทั้งหมด)"}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="Campaign (broadcast job id)"
              value={broadcastJobId}
              onChange={setBroadcastJobId}
              placeholder="broadcast send_job uuid"
            />
          </div>
          <button
            type="button"
            onClick={() => void search()}
            disabled={loading}
            className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {loading ? "ค้นหา..." : "ค้นหา"}
          </button>
        </section>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {searched && (
          <section className="rounded-2xl border border-gray-200 bg-white">
            <div className="p-4 border-b border-gray-100">
              <h2 className="text-sm font-bold text-gray-900">
                ผลลัพธ์ ({results.length})
              </h2>
            </div>
            {results.length === 0 ? (
              <p className="p-6 text-center text-sm text-gray-500">
                ไม่พบข้อความที่ตรงกับเงื่อนไข
              </p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {results.map((r) => (
                  <li key={r.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-gray-700">
                            {r.channel}
                          </span>
                          <span className="text-xs font-semibold text-gray-900">
                            {r.kind}
                          </span>
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                              r.status === "delivered"
                                ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                                : r.status === "failed" ||
                                    r.status === "dead_letter"
                                  ? "border-red-300 bg-red-50 text-red-800"
                                  : "border-gray-200 bg-gray-50 text-gray-700"
                            }`}
                          >
                            {r.status}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-gray-500">
                          {r.provider_message_id
                            ? `pmid ${r.provider_message_id} · `
                            : ""}
                          attempts {r.attempts} · {r.branch_id ?? "—"} ·{" "}
                          created {fmt(r.created_at)}
                          {r.error_reason ? ` · ⚠ ${r.error_reason}` : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded(expanded === r.id ? null : r.id)
                        }
                        className="text-[11px] font-semibold text-green-700 hover:text-green-900 underline"
                      >
                        {expanded === r.id ? "ซ่อน timeline" : "timeline"}
                      </button>
                    </div>
                    {expanded === r.id && (
                      <div className="mt-3 rounded-xl bg-gray-50 p-3">
                        <DeliveryTimeline notificationId={r.id} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-gray-700">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
      />
    </label>
  );
}
