"use client";

// /admin/system/smoke-test — production-readiness checklist.
//
// Phase 21. Owner / HQ only. Calls /api/admin/system/smoke-test and
// renders a per-row pass/fail grid grouped by category. The whole
// page exists so an operator who just deployed a new branch can:
//
//   1. Log in as owner
//   2. Open /admin/system/smoke-test
//   3. Hit refresh
//   4. See exactly which env var / table / provider is missing
//      without reading any source code.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";

type CheckStatus = "ok" | "warn" | "missing" | "error";

type Check = {
  name: string;
  status: CheckStatus;
  message: string;
  category: "config" | "db" | "workers" | "broadcast" | "security";
  detail?: Record<string, unknown>;
};

type Response = {
  ok: boolean;
  generatedAt: string;
  overall: "healthy" | "degraded" | "critical";
  summary: {
    total: number;
    ok: number;
    warn: number;
    missing: number;
    error: number;
  };
  checks: Check[];
  reason?: string;
};

const CATEGORY_LABEL: Record<Check["category"], string> = {
  config: "Configuration",
  db: "Database",
  workers: "Workers",
  broadcast: "Broadcast pipeline",
  security: "Security",
};

const STATUS_TONE: Record<CheckStatus, string> = {
  ok: "border-green-300 bg-green-50 text-green-800",
  warn: "border-amber-300 bg-amber-50 text-amber-800",
  missing: "border-red-300 bg-red-50 text-red-800",
  error: "border-red-300 bg-red-50 text-red-800",
};

const STATUS_LABEL: Record<CheckStatus, string> = {
  ok: "OK",
  warn: "WARN",
  missing: "MISSING",
  error: "ERROR",
};

const OVERALL_TONE: Record<Response["overall"], string> = {
  healthy: "border-green-300 bg-green-50 text-green-900",
  degraded: "border-amber-300 bg-amber-50 text-amber-900",
  critical: "border-red-300 bg-red-50 text-red-900",
};

export default function SmokeTestPage() {
  return (
    <RouteGuard page="admin">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/system/smoke-test", {
        cache: "no-store",
      });
      const json = (await res.json()) as Response;
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groupedByCategory = (data?.checks ?? []).reduce(
    (acc, c) => {
      if (!acc[c.category]) acc[c.category] = [];
      acc[c.category].push(c);
      return acc;
    },
    {} as Record<Check["category"], Check[]>
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
          <span className="text-gray-700 font-medium">Smoke test</span>
        </div>

        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold text-gray-900">
              Production smoke test
            </h1>
            <p className="text-xs text-gray-500">
              ตรวจสอบ env vars / DB tables / worker streaks / provider configs / emergency stop
              ในจุดเดียว — รันก่อนเปิดสาขาใหม่ หรือหลัง deploy
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {loading ? "กำลังตรวจ..." : "Run checks"}
          </button>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {data && (
          <section
            className={`rounded-2xl border-2 p-4 ${OVERALL_TONE[data.overall]}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="text-xs uppercase tracking-wider opacity-80">
                  Overall
                </div>
                <div className="text-xl font-extrabold">{data.overall}</div>
              </div>
              <div className="grid grid-cols-4 gap-3 text-xs">
                <SummaryCell label="OK" value={data.summary.ok} />
                <SummaryCell label="WARN" value={data.summary.warn} />
                <SummaryCell label="MISSING" value={data.summary.missing} />
                <SummaryCell label="ERROR" value={data.summary.error} />
              </div>
            </div>
            <div className="mt-2 text-[10px] opacity-70">
              checked {new Date(data.generatedAt).toLocaleString("th-TH")}
            </div>
          </section>
        )}

        {data &&
          (Object.keys(groupedByCategory) as Array<Check["category"]>).map(
            (cat) => (
              <section
                key={cat}
                className="rounded-2xl border border-gray-200 bg-white"
              >
                <div className="p-4 border-b border-gray-100">
                  <h2 className="text-base font-bold text-gray-900">
                    {CATEGORY_LABEL[cat]}
                  </h2>
                  <p className="text-[10px] text-gray-500">
                    {groupedByCategory[cat].length} check
                    {groupedByCategory[cat].length > 1 ? "s" : ""}
                  </p>
                </div>
                <ul className="divide-y divide-gray-100">
                  {groupedByCategory[cat].map((c) => (
                    <li
                      key={c.name}
                      className="flex items-start justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-mono font-semibold text-gray-900 truncate">
                          {c.name}
                        </div>
                        <div className="text-xs text-gray-700 mt-0.5">
                          {c.message}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                          STATUS_TONE[c.status]
                        }`}
                      >
                        {STATUS_LABEL[c.status]}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )
          )}

        <p className="text-[11px] text-gray-500 text-center">
          การตรวจสอบไม่ได้แก้ไขข้อมูล — ปลอดภัยจะรันบ่อยแค่ไหนก็ได้
        </p>
      </div>
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-lg font-extrabold">{value}</div>
    </div>
  );
}
