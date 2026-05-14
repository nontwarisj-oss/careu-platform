"use client";

// /admin/settings/communications — per-branch communications toggles.
//
// Owner / hq_admin only. The UI lets operators:
//   • Pick a branch (or "global").
//   • Toggle SMS / LINE / scheduled / cross-branch broadcasts.
//   • Set quiet-hour window + caps + dedup window.
//   • Save (POST to /api/admin/settings/communications) — branch
//     override is written; clicking "revert" deletes the override.
//
// Effective values rule: branch override wins over global. Cleared
// branch override → global value applies.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { branches as ALL_BRANCHES } from "@/lib/brandConfig";

type FlagRow = {
  key: string;
  value: unknown;
  branch_id: string | null;
  notes: string | null;
  updated_at: string;
  updated_by: string | null;
};

const EDITABLE_KEYS = [
  "enable_sms",
  "enable_line_broadcast",
  "enable_scheduled_broadcasts",
  "enable_cross_branch_broadcasts",
  "broadcast_max_targets_per_job",
  "broadcast_quiet_hours_start_h",
  "broadcast_quiet_hours_end_h",
  "broadcast_dedup_window_hours",
] as const;

type EditableKey = (typeof EDITABLE_KEYS)[number];

const KEY_LABEL: Record<EditableKey, string> = {
  enable_sms: "เปิดใช้งาน SMS broadcast",
  enable_line_broadcast: "เปิดใช้งาน LINE broadcast",
  enable_scheduled_broadcasts: "อนุญาตให้ตั้งเวลาส่ง",
  enable_cross_branch_broadcasts: "อนุญาตให้ส่งข้ามสาขา",
  broadcast_max_targets_per_job: "จำนวนเป้าหมายสูงสุดต่องาน",
  broadcast_quiet_hours_start_h: "เริ่มเวลาส่ง (ชั่วโมง, Bangkok)",
  broadcast_quiet_hours_end_h: "หยุดเวลาส่ง (ชั่วโมง, Bangkok)",
  broadcast_dedup_window_hours: "Cross-draft dedup window (ชั่วโมง)",
};

const NUMERIC_KEYS = new Set<EditableKey>([
  "broadcast_max_targets_per_job",
  "broadcast_quiet_hours_start_h",
  "broadcast_quiet_hours_end_h",
  "broadcast_dedup_window_hours",
]);

export default function CommunicationsSettingsPage() {
  return (
    <RouteGuard page="admin">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const [rows, setRows] = useState<FlagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<EditableKey, unknown>>(
    () => ({} as Record<EditableKey, unknown>)
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/communications", {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        rows?: FlagRow[];
        reason?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `โหลดล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setRows(json.rows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const effective: Record<EditableKey, { value: unknown; source: "branch" | "global" | "fallback" }> = useMemo(() => {
    const result = {} as Record<
      EditableKey,
      { value: unknown; source: "branch" | "global" | "fallback" }
    >;
    for (const k of EDITABLE_KEYS) {
      const branchRow = rows.find(
        (r) => r.key === k && r.branch_id === branchId
      );
      const globalRow = rows.find((r) => r.key === k && r.branch_id === null);
      if (branchId && branchRow) {
        result[k] = { value: branchRow.value, source: "branch" };
      } else if (globalRow) {
        result[k] = { value: globalRow.value, source: "global" };
      } else {
        result[k] = { value: null, source: "fallback" };
      }
    }
    return result;
  }, [rows, branchId]);

  const currentDraft = useCallback(
    (k: EditableKey): unknown => {
      if (k in draft) return draft[k];
      return effective[k].value;
    },
    [draft, effective]
  );

  const setDraftValue = (k: EditableKey, v: unknown) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setMessage(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/settings/communications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId, values: draft }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        changes?: Array<{ key: string; action: string }>;
        errors?: Array<{ key: string; reason: string }>;
      };
      if (!res.ok || !json.ok) {
        const err =
          json.errors && json.errors.length > 0
            ? json.errors.map((e) => `${e.key}: ${e.reason}`).join(" / ")
            : (json.reason ?? `บันทึกไม่สำเร็จ (HTTP ${res.status})`);
        setError(err);
        return;
      }
      setMessage(
        `บันทึก ${(json.changes ?? []).length} รายการ — มีผลทันที (cache ${60}s)`
      );
      setDraft({} as Record<EditableKey, unknown>);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  const handleRevertBranchOverride = async (k: EditableKey) => {
    if (!branchId) return;
    if (!window.confirm("ลบ override สาขานี้สำหรับ key นี้?")) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/communications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId,
          values: { [k]: null },
        }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `ล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setMessage(`ลบ override ${k} แล้ว — ใช้ global value`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-gray-500">โหลด...</div>
    );
  }

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Settings · Communications</span>
        </div>

        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">
            การตั้งค่าการสื่อสาร
          </h1>
          <p className="text-sm text-gray-600">
            ตั้งค่าช่องทาง / quiet hours / caps — สามารถ override ต่อสาขาได้
          </p>
        </div>

        {message && (
          <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            {message}
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <label className="text-sm font-semibold text-gray-800">
              ขอบเขต
            </label>
            <select
              value={branchId ?? ""}
              onChange={(e) =>
                setBranchId(e.target.value === "" ? null : e.target.value)
              }
              className="rounded-lg border border-gray-200 px-2 py-1 text-sm"
            >
              <option value="">Global (ทุกสาขา)</option>
              {ALL_BRANCHES.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.shortLabel}
                </option>
              ))}
            </select>
          </div>
          <p className="text-[11px] text-gray-500">
            ค่าของสาขาจะ override global. {branchId
              ? "แก้ที่นี่กระทบเฉพาะสาขาที่เลือก"
              : "แก้ที่นี่กระทบทุกสาขาที่ไม่มี override"}
          </p>
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
          <h2 className="text-base font-bold text-gray-900">ค่าต่างๆ</h2>
          <div className="divide-y divide-gray-100">
            {EDITABLE_KEYS.map((k) => {
              const eff = effective[k];
              const value = currentDraft(k);
              const isNumeric = NUMERIC_KEYS.has(k);
              const isOverrideOfBranch =
                branchId !== null && eff.source === "branch";
              return (
                <div key={k} className="py-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-gray-900">
                      {KEY_LABEL[k]}
                    </div>
                    <div className="text-[10px] text-gray-500">
                      <code>{k}</code> · ใช้ค่าจาก{" "}
                      <strong>
                        {eff.source === "branch"
                          ? "สาขา"
                          : eff.source === "global"
                            ? "global"
                            : "fallback"}
                      </strong>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isNumeric ? (
                      <input
                        type="number"
                        inputMode="numeric"
                        value={
                          typeof value === "number"
                            ? value
                            : typeof value === "string"
                              ? Number(value)
                              : ""
                        }
                        onChange={(e) =>
                          setDraftValue(k, Number(e.target.value))
                        }
                        className="w-24 rounded-lg border border-gray-200 px-2 py-1 text-sm text-right"
                      />
                    ) : (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={value === true}
                        onClick={() => setDraftValue(k, !(value === true))}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
                          value === true ? "bg-green-600" : "bg-gray-300"
                        }`}
                      >
                        <span
                          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                            value === true ? "translate-x-5" : "translate-x-0.5"
                          } self-center`}
                        />
                      </button>
                    )}
                    {isOverrideOfBranch && (
                      <button
                        type="button"
                        onClick={() => void handleRevertBranchOverride(k)}
                        title="ลบ override สาขานี้ → ใช้ global"
                        className="text-[10px] text-red-700 hover:text-red-900 underline whitespace-nowrap"
                      >
                        revert
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || Object.keys(draft).length === 0}
            className="mt-3 w-full rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {saving
              ? "กำลังบันทึก..."
              : Object.keys(draft).length === 0
                ? "ไม่มีการเปลี่ยนแปลง"
                : `บันทึก ${Object.keys(draft).length} รายการ`}
          </button>
        </section>

        <p className="text-[11px] text-gray-500 text-center">
          การตั้งค่ามีผลทันที — server-side cache ใช้ TTL 60 วินาที.
        </p>
      </div>
    </div>
  );
}
