"use client";

// /admin/system/branch-health — per-branch operational health.
//
// Phase 24. Owner / HQ see every branch (HQ view); a branch_manager
// sees only their own branch (the API scopes it server-side). Uses
// the `recovery` page key so branch managers — who already have
// recovery access — can reach it.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";

type BranchHealth = {
  branchId: string;
  branchLabel: string;
  failedSends24h: number;
  deadLetters: number;
  stuckBroadcastJobs: number;
  unresolvedAlerts: number;
  criticalAlerts: number;
  pausedCampaigns: number;
  status: "healthy" | "warning" | "critical";
};

const STATUS_TONE: Record<string, string> = {
  healthy: "border-green-300 bg-green-50 text-green-800",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  critical: "border-red-300 bg-red-100 text-red-900",
};

export default function BranchHealthPage() {
  return (
    <RouteGuard page="recovery">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const [branches, setBranches] = useState<BranchHealth[]>([]);
  const [scope, setScope] = useState<"all" | "branch">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/system/branch-health", {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        scope?: "all" | "branch";
        generatedAt?: string;
        branches?: BranchHealth[];
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      setBranches(json.branches ?? []);
      setScope(json.scope ?? "all");
      setGeneratedAt(json.generatedAt ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">System · Branch health</span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold text-gray-900">
              Branch health
            </h1>
            <p className="text-xs text-gray-500">
              {scope === "branch"
                ? "สุขภาพการดำเนินงานของสาขาคุณ"
                : "สุขภาพการดำเนินงานต่อสาขา — เรียงจากแย่สุด"}
              {generatedAt &&
                ` · อัปเดต ${new Date(generatedAt).toLocaleString("th-TH")}`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700 disabled:opacity-50"
          >
            {loading ? "โหลด..." : "รีเฟรช"}
          </button>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {loading && branches.length === 0 ? (
          <p className="text-sm text-gray-500">โหลด...</p>
        ) : branches.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
            ไม่มีข้อมูลสาขา
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {branches.map((b) => (
              <section
                key={b.branchId}
                className={`rounded-2xl border-2 p-4 ${STATUS_TONE[b.status]}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-extrabold">{b.branchLabel}</h2>
                  <span className="rounded-full border border-current/30 bg-white/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                    {b.status}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Metric
                    label="Failed sends (24h)"
                    value={b.failedSends24h}
                    bad={b.failedSends24h > 0}
                  />
                  <Metric
                    label="Dead-letter"
                    value={b.deadLetters}
                    bad={b.deadLetters > 0}
                  />
                  <Metric
                    label="Stuck broadcasts"
                    value={b.stuckBroadcastJobs}
                    bad={b.stuckBroadcastJobs > 0}
                  />
                  <Metric
                    label="Unresolved alerts"
                    value={b.unresolvedAlerts}
                    bad={b.criticalAlerts > 0}
                    note={b.criticalAlerts > 0 ? `${b.criticalAlerts} critical` : undefined}
                  />
                  <Metric
                    label="Paused campaigns"
                    value={b.pausedCampaigns}
                    bad={false}
                  />
                </div>
              </section>
            ))}
          </div>
        )}

        <p className="text-[11px] text-gray-500 text-center">
          critical = dead-letter / stuck broadcast / critical alert ·
          warning = failed sends หรือ alert ที่ยังไม่ปิด
        </p>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  bad,
  note,
}: {
  label: string;
  value: number;
  bad: boolean;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-current/20 bg-white/70 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider font-semibold opacity-70">
        {label}
      </p>
      <p
        className={`mt-0.5 text-lg font-extrabold ${
          bad ? "text-red-700" : "text-gray-900"
        }`}
      >
        {value.toLocaleString()}
      </p>
      {note && <p className="text-[10px] text-red-700">{note}</p>}
    </div>
  );
}
