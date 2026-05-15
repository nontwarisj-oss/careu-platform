"use client";

// /admin/system/alert-preferences — operator alert routing config.
//
// Phase 23. Owner / HQ only. Controls, per branch (with a global
// default):
//   • recipient email addresses
//   • minimum severity worth a push
//   • alert quiet hours (non-critical held back)
//   • alert delivery on/off
//   • weekly operator digest opt-in

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { branches as ALL_BRANCHES } from "@/lib/brandConfig";

type Row = {
  id: string;
  branch_id: string | null;
  recipients: string[];
  min_severity: "warning" | "critical";
  quiet_hours_start_h: number | null;
  quiet_hours_end_h: number | null;
  enabled: boolean;
  digest_enabled: boolean;
  updated_at: string;
};

type Draft = {
  recipients: string;
  minSeverity: "warning" | "critical";
  quietHoursStartH: number | null;
  quietHoursEndH: number | null;
  enabled: boolean;
  digestEnabled: boolean;
};

const EMPTY_DRAFT: Draft = {
  recipients: "",
  minSeverity: "warning",
  quietHoursStartH: null,
  quietHoursEndH: null,
  enabled: true,
  digestEnabled: true,
};

export default function AlertPreferencesPage() {
  return (
    <RouteGuard page="admin">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string>(""); // "" = global
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/system/alert-preferences", {
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

  const currentRow = useMemo(
    () => rows.find((r) => (r.branch_id ?? "") === branchId) ?? null,
    [rows, branchId]
  );

  // Sync the draft when the selected scope changes.
  useEffect(() => {
    if (currentRow) {
      setDraft({
        recipients: (currentRow.recipients ?? []).join(", "),
        minSeverity: currentRow.min_severity,
        quietHoursStartH: currentRow.quiet_hours_start_h,
        quietHoursEndH: currentRow.quiet_hours_end_h,
        enabled: currentRow.enabled,
        digestEnabled: currentRow.digest_enabled,
      });
    } else {
      setDraft(EMPTY_DRAFT);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, rows.length]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/system/alert-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: branchId || null,
          recipients: draft.recipients
            .split(/[,\n;]/)
            .map((s) => s.trim())
            .filter(Boolean),
          minSeverity: draft.minSeverity,
          quietHoursStartH: draft.quietHoursStartH,
          quietHoursEndH: draft.quietHoursEndH,
          enabled: draft.enabled,
          digestEnabled: draft.digestEnabled,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      setMessage("บันทึกแล้ว — มีผลภายใน ~60 วินาที");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  const deleteBranchRow = async () => {
    if (!branchId) return;
    if (!window.confirm("ลบการตั้งค่าของสาขานี้ → กลับไปใช้ global default?"))
      return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/system/alert-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId, delete: true }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      setMessage("ลบแล้ว — สาขานี้ใช้ global default");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-2xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <Link href="/admin/system/workers" className="hover:text-green-700">
            System
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Alert preferences</span>
        </div>

        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">
            Alert delivery preferences
          </h1>
          <p className="text-xs text-gray-500">
            ใครได้รับ alert · ระดับความรุนแรงขั้นต่ำ · quiet hours ·
            digest รายสัปดาห์ — ตั้งต่อสาขาได้
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

        <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-4">
          <label className="block">
            <span className="text-[11px] font-semibold text-gray-700">
              ขอบเขต
            </span>
            <select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
            >
              <option value="">🌐 Global default</option>
              {ALL_BRANCHES.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.shortLabel}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] text-gray-500">
              {branchId
                ? currentRow
                  ? "สาขานี้มี override — recipients จะรวมกับ global"
                  : "ยังไม่มี override — บันทึกเพื่อสร้าง"
                : "ค่าเริ่มต้นสำหรับทุกสาขาที่ไม่มี override"}
            </span>
          </label>

          {loading ? (
            <p className="text-sm text-gray-500">โหลด...</p>
          ) : (
            <>
              <label className="block">
                <span className="text-[11px] font-semibold text-gray-700">
                  Email recipients (คั่นด้วย comma)
                </span>
                <textarea
                  value={draft.recipients}
                  onChange={(e) =>
                    setDraft({ ...draft, recipients: e.target.value })
                  }
                  rows={2}
                  placeholder="ops@careu.tech, owner@careu.tech"
                  className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
                />
              </label>

              <label className="block">
                <span className="text-[11px] font-semibold text-gray-700">
                  ระดับขั้นต่ำที่จะส่ง
                </span>
                <select
                  value={draft.minSeverity}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      minSeverity: e.target.value as "warning" | "critical",
                    })
                  }
                  className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
                >
                  <option value="warning">warning ขึ้นไป (ส่งทุก alert)</option>
                  <option value="critical">critical เท่านั้น</option>
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <HourSelect
                  label="Quiet hours เริ่ม"
                  value={draft.quietHoursStartH}
                  onChange={(h) =>
                    setDraft({ ...draft, quietHoursStartH: h })
                  }
                />
                <HourSelect
                  label="Quiet hours สิ้นสุด"
                  value={draft.quietHoursEndH}
                  onChange={(h) => setDraft({ ...draft, quietHoursEndH: h })}
                />
              </div>
              <p className="text-[10px] text-gray-500">
                ในช่วง quiet hours: alert ระดับ warning จะถูกพักไว้ —
                critical ส่งเสมอ. เว้นว่างทั้งคู่ = ไม่มี quiet hours.
              </p>

              <ToggleRow
                label="เปิดการส่ง alert"
                hint="ปิด = alert ยังถูกบันทึก แต่ไม่ push"
                checked={draft.enabled}
                onChange={(v) => setDraft({ ...draft, enabled: v })}
              />
              <ToggleRow
                label="รับ digest รายสัปดาห์"
                hint="สรุปยอดขาย / งานล้มเหลว / broadcast / CRM ทุกสัปดาห์"
                checked={draft.digestEnabled}
                onChange={(v) => setDraft({ ...draft, digestEnabled: v })}
              />

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  className="flex-1 rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
                >
                  {saving ? "กำลังบันทึก..." : "บันทึก"}
                </button>
                {branchId && currentRow && (
                  <button
                    type="button"
                    onClick={() => void deleteBranchRow()}
                    disabled={saving}
                    className="rounded-xl border border-red-200 bg-red-50 hover:bg-red-100 text-red-800 px-3 py-2 text-sm font-semibold disabled:opacity-50"
                  >
                    ลบ override
                  </button>
                )}
              </div>
            </>
          )}
        </section>

        <p className="text-[11px] text-gray-500 text-center">
          การส่ง email ใช้ provider จาก EMAIL_PROVIDER — ถ้ายังไม่ตั้งจะ log
          ลง console เท่านั้น (ไม่ crash). ทุกการแก้ไข audit ลง
          cron_heartbeat_logs.
        </p>
      </div>
    </div>
  );
}

function HourSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (h: number | null) => void;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-gray-700">{label}</span>
      <select
        value={value == null ? "" : String(value)}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
        className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1 text-sm"
      >
        <option value="">—</option>
        {Array.from({ length: 24 }, (_, h) => (
          <option key={h} value={h}>
            {String(h).padStart(2, "0")}:00
          </option>
        ))}
      </select>
    </label>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2 py-1">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-gray-900">{label}</div>
        <div className="text-[10px] text-gray-500">{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
          checked ? "bg-green-600" : "bg-gray-300"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          } self-center`}
        />
      </button>
    </div>
  );
}
