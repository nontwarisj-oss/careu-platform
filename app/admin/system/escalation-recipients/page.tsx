"use client";

// /admin/system/escalation-recipients — role-tiered alert contact list.
//
// Phase 25. Owner / HQ only. Each row pins a contact to an escalation
// tier (owner / hq_admin / branch_manager / technician_lead) with a
// severity floor, optional branch scope, and a temporary-mute window.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { branches as ALL_BRANCHES } from "@/lib/brandConfig";

type Row = {
  id: string;
  role_tier: string;
  branch_id: string | null;
  label: string | null;
  email: string | null;
  line_target: string | null;
  min_severity: "warning" | "critical";
  muted_until: string | null;
  enabled: boolean;
  updated_at: string;
};

const ROLE_TIERS = [
  "branch_manager",
  "technician_lead",
  "hq_admin",
  "owner",
] as const;

const EMPTY = {
  roleTier: "branch_manager" as string,
  branchId: "",
  label: "",
  email: "",
  lineTarget: "",
  minSeverity: "warning" as "warning" | "critical",
  enabled: true,
};

export default function EscalationRecipientsPage() {
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
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/system/escalation-recipients", {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        rows?: Row[];
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
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (payload: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/system/escalation-recipients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      setMessage(okMsg);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    post(
      {
        roleTier: form.roleTier,
        branchId: form.branchId || null,
        label: form.label || null,
        email: form.email || null,
        lineTarget: form.lineTarget || null,
        minSeverity: form.minSeverity,
        enabled: form.enabled,
      },
      "เพิ่ม recipient แล้ว"
    ).then(() => setForm({ ...EMPTY }));

  const muteFor = (id: string, hours: number) =>
    post(
      {
        id,
        // server keeps other fields from the existing row only if we
        // resend them; instead just patch mute by resending the row.
        ...rowPatch(rows.find((r) => r.id === id)),
        mutedUntil:
          hours > 0
            ? new Date(Date.now() + hours * 3600_000).toISOString()
            : null,
      },
      hours > 0 ? `mute ${hours}h แล้ว` : "unmute แล้ว"
    );

  const toggleEnabled = (r: Row) =>
    post(
      { ...rowPatch(r), enabled: !r.enabled },
      r.enabled ? "ปิดใช้งานแล้ว" : "เปิดใช้งานแล้ว"
    );

  const remove = (id: string) => {
    if (!window.confirm("ลบ recipient นี้?")) return;
    void post({ id, delete: true }, "ลบแล้ว");
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <Link href="/admin/system/workers" className="hover:text-green-700">
            System
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Escalation recipients</span>
        </div>

        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">
            Escalation recipients
          </h1>
          <p className="text-xs text-gray-500">
            รายชื่อผู้รับ alert ตามลำดับชั้น — alert tier → branch + technician
            lead · hq tier → + HQ · owner tier → + owner
          </p>
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

        {/* Add form */}
        <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
          <h2 className="text-sm font-bold text-gray-900">เพิ่ม recipient</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            <Labeled label="Role tier">
              <select
                value={form.roleTier}
                onChange={(e) => setForm({ ...form, roleTier: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              >
                {ROLE_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled label="Branch (เว้นว่าง = ทุกสาขา)">
              <select
                value={form.branchId}
                onChange={(e) => setForm({ ...form, branchId: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              >
                <option value="">ทุกสาขา</option>
                {ALL_BRANCHES.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.shortLabel}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled label="Label">
              <input
                type="text"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="เช่น ผจก.ทรบ."
                className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              />
            </Labeled>
            <Labeled label="Min severity">
              <select
                value={form.minSeverity}
                onChange={(e) =>
                  setForm({
                    ...form,
                    minSeverity: e.target.value as "warning" | "critical",
                  })
                }
                className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              >
                <option value="warning">warning ขึ้นไป</option>
                <option value="critical">critical เท่านั้น</option>
              </select>
            </Labeled>
            <Labeled label="Email">
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="ops@careu.tech"
                className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              />
            </Labeled>
            <Labeled label="LINE target (user/group id)">
              <input
                type="text"
                value={form.lineTarget}
                onChange={(e) =>
                  setForm({ ...form, lineTarget: e.target.value })
                }
                placeholder="Cxxxxxxxx"
                className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              />
            </Labeled>
          </div>
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy}
            className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            เพิ่ม
          </button>
        </section>

        {/* List */}
        <section className="rounded-2xl border border-gray-200 bg-white">
          <div className="p-4 border-b border-gray-100">
            <h2 className="text-sm font-bold text-gray-900">
              Recipients ({rows.length})
            </h2>
          </div>
          {loading ? (
            <p className="p-4 text-sm text-gray-500">โหลด...</p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-500">
              ยังไม่มี recipient — alert จะ fallback ไปที่ alert_preferences
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {rows.map((r) => {
                const muted =
                  r.muted_until &&
                  new Date(r.muted_until).getTime() > Date.now();
                return (
                  <li key={r.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="rounded-full border border-gray-300 bg-gray-50 px-2 py-0.5 text-[10px] font-semibold text-gray-700">
                            {r.role_tier}
                          </span>
                          <span className="text-sm font-semibold text-gray-900">
                            {r.label ?? r.email ?? r.line_target}
                          </span>
                          {!r.enabled && (
                            <span className="text-[10px] text-gray-400">
                              (disabled)
                            </span>
                          )}
                          {muted && (
                            <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                              muted
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] text-gray-500">
                          {r.email ?? "—"}
                          {r.line_target ? ` · LINE ${r.line_target}` : ""} ·{" "}
                          {r.branch_id ?? "ทุกสาขา"} · ≥{r.min_severity}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2 text-[11px]">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void toggleEnabled(r)}
                          className="rounded-md border border-gray-200 bg-gray-50 hover:bg-gray-100 px-2 py-1 font-semibold text-gray-700"
                        >
                          {r.enabled ? "disable" : "enable"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void muteFor(r.id, muted ? 0 : 24)}
                          className="rounded-md border border-amber-200 bg-amber-50 hover:bg-amber-100 px-2 py-1 font-semibold text-amber-800"
                        >
                          {muted ? "unmute" : "mute 24h"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => remove(r.id)}
                          className="rounded-md border border-red-200 bg-red-50 hover:bg-red-100 px-2 py-1 font-semibold text-red-700"
                        >
                          ลบ
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** Re-send an existing row's editable fields so a partial PATCH
 *  (mute / enable toggle) doesn't blank the other columns. */
function rowPatch(r: Row | undefined): Record<string, unknown> {
  if (!r) return {};
  return {
    id: r.id,
    roleTier: r.role_tier,
    branchId: r.branch_id,
    label: r.label,
    email: r.email,
    lineTarget: r.line_target,
    minSeverity: r.min_severity,
    enabled: r.enabled,
  };
}

function Labeled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-gray-700">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
