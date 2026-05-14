"use client";

// /admin/crm/triggers — explainability view for retention triggers.
// Per row shows: why fired, which rules matched, why skipped (when
// skipped), customer/channel/branch.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";

type Row = {
  id: string;
  customer_id: string;
  customer_name: string | null;
  trigger_kind: string;
  channel: string;
  status: string;
  skip_reason: string | null;
  fired_reason: string | null;
  notification_id: string | null;
  branch_id: string | null;
  created_at: string;
};

const STATUS_TONE: Record<string, string> = {
  queued: "border-yellow-200 bg-yellow-50 text-yellow-800",
  dispatched: "border-green-200 bg-green-50 text-green-800",
  skipped: "border-gray-200 bg-gray-50 text-gray-700",
  failed: "border-red-200 bg-red-50 text-red-800",
};

const KIND_LABEL: Record<string, string> = {
  no_visit_x_days: "ไม่มาเกิน 60 วัน",
  pickup_overdue: "งานค้างรอรับ",
  inactive_vip: "VIP เงียบ",
  high_spend_dormant: "ลูกค้าใหญ่ dormant",
  birthday_month: "เดือนเกิด",
  first_time_followup: "ตามครั้งแรก",
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

export default function TriggersExplainabilityPage() {
  return (
    <RouteGuard page="admin">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [kindFilter, setKindFilter] = useState<string>("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (kindFilter) params.set("kind", kindFilter);
      const res = await fetch(
        `/api/admin/crm/triggers?${params.toString()}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as {
        ok?: boolean;
        triggers?: Row[];
        reason?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `โหลดล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setRows(json.triggers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, kindFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <Link href="/admin/crm/engagement" className="hover:text-green-700">
            CRM
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Trigger explainability</span>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold text-gray-900">
              Why this trigger fired
            </h1>
            <p className="text-xs text-gray-500">
              เห็นเหตุผลของทุก retention trigger — ทำไมยิง / ทำไม skip / ใช้ rule
              ไหน
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-gray-200 px-2 py-1 text-xs"
            >
              <option value="">ทุก status</option>
              <option value="dispatched">dispatched</option>
              <option value="skipped">skipped</option>
              <option value="failed">failed</option>
              <option value="queued">queued</option>
            </select>
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              className="rounded-lg border border-gray-200 px-2 py-1 text-xs"
            >
              <option value="">ทุก kind</option>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="p-8 text-gray-500">โหลด...</div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
            ยังไม่มี trigger ที่ตรงเงื่อนไข
          </div>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li
                key={r.id}
                className="rounded-2xl border border-gray-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/admin/customers/${r.customer_id}`}
                        className="text-sm font-semibold text-gray-900 hover:text-green-700"
                      >
                        {r.customer_name ?? "(ไม่มีชื่อ)"}
                      </Link>
                      <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-700">
                        {KIND_LABEL[r.trigger_kind] ?? r.trigger_kind}
                      </span>
                      <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-700">
                        {r.channel.toUpperCase()}
                      </span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                          STATUS_TONE[r.status] ?? STATUS_TONE.skipped
                        }`}
                      >
                        {r.status}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-gray-500">
                      {r.branch_id ?? "—"} · {fmt(r.created_at)}
                    </p>
                  </div>
                  {r.notification_id && (
                    <span className="font-mono text-[10px] text-gray-500">
                      notif {r.notification_id.slice(0, 8)}
                    </span>
                  )}
                </div>
                {r.fired_reason && (
                  <div className="mt-2 text-xs text-gray-700">
                    <span className="text-green-700 font-semibold">
                      ทำไมยิง:
                    </span>{" "}
                    {r.fired_reason}
                  </div>
                )}
                {r.skip_reason && (
                  <div className="mt-1 text-xs text-gray-700">
                    <span className="text-red-700 font-semibold">
                      ทำไม skip:
                    </span>{" "}
                    {r.skip_reason}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
