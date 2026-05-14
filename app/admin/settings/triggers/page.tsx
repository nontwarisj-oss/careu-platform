"use client";

// /admin/settings/triggers — per-branch trigger override editor.
//
// Sibling page to /admin/settings/communications. Lets owner / HQ /
// branch_manager tune retention thresholds + quiet hours + caps per
// branch without redeploy. Falls back to HQ defaults when a key has
// no row.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { branches as ALL_BRANCHES } from "@/lib/brandConfig";

type Row = {
  id: string;
  branch_id: string;
  key: string;
  value: unknown;
  notes: string | null;
  updated_at: string;
  updated_by: string | null;
};

// Phase 19 + Phase 20 editable keys + Thai labels + input kind.
const EDITABLE: Array<{
  key: string;
  label: string;
  kind: "number" | "boolean";
  hint?: string;
}> = [
  { key: "dormant_days", label: "Dormant threshold (days)", kind: "number", hint: "ลูกค้าจะถูกจัดเป็น dormant เมื่อขาดติดต่อนานกว่านี้" },
  { key: "at_risk_days", label: "At-risk threshold (days)", kind: "number", hint: "ลูกค้ามีประวัติ ≥ 3 ออเดอร์และไม่กลับมา" },
  { key: "overdue_pickup_delay_days", label: "Overdue pickup grace (days)", kind: "number" },
  { key: "retention_cooldown_days", label: "Retention cooldown (days)", kind: "number", hint: "no_visit_x_days dedup window" },
  { key: "vip_reactivation_delay_days", label: "VIP reactivation gap (days)", kind: "number" },
  { key: "max_daily_trigger_sends", label: "Max daily trigger sends", kind: "number", hint: "advisory cap" },
  { key: "quiet_hours_start_h", label: "Quiet hours start (BKK hour)", kind: "number" },
  { key: "quiet_hours_end_h", label: "Quiet hours end (BKK hour, exclusive)", kind: "number" },
  { key: "quiet_hours_enforced", label: "Enforce quiet hours", kind: "boolean" },
  { key: "birthday_trigger_enabled", label: "Enable birthday trigger", kind: "boolean" },
];

const HQ_DEFAULTS: Record<string, unknown> = {
  dormant_days: 180,
  at_risk_days: 90,
  overdue_pickup_delay_days: 2,
  retention_cooldown_days: 30,
  vip_reactivation_delay_days: 45,
  max_daily_trigger_sends: 200,
  quiet_hours_start_h: 9,
  quiet_hours_end_h: 19,
  quiet_hours_enforced: true,
  birthday_trigger_enabled: true,
};

export default function BranchTriggersPage() {
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
  const [saving, setSaving] = useState(false);
  const [branchId, setBranchId] = useState<string>("");
  const [draft, setDraft] = useState<Record<string, unknown>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/settings/branch-triggers", {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const effective = useMemo(() => {
    const out: Record<string, { value: unknown; source: "branch" | "default" }> = {};
    for (const k of EDITABLE) {
      const row = rows.find((r) => r.branch_id === branchId && r.key === k.key);
      if (row) {
        out[k.key] = { value: row.value, source: "branch" };
      } else {
        out[k.key] = { value: HQ_DEFAULTS[k.key], source: "default" };
      }
    }
    return out;
  }, [rows, branchId]);

  const draftValueFor = (k: string): unknown =>
    k in draft ? draft[k] : effective[k]?.value;

  const handleSave = async () => {
    if (!branchId) {
      setError("เลือกสาขาก่อน");
      return;
    }
    if (Object.keys(draft).length === 0) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/branch-triggers", {
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
          (json.errors ?? []).map((e) => `${e.key}: ${e.reason}`).join(" / ") ||
          json.reason ||
          `HTTP ${res.status}`;
        setError(err);
        return;
      }
      setMessage(
        `บันทึก ${(json.changes ?? []).filter((c) => c.action !== "noop").length} รายการ`
      );
      setDraft({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  const handleRevert = async (key: string) => {
    if (!branchId) return;
    if (!window.confirm(`ลบ override ${key} ของสาขานี้ → ใช้ HQ default?`)) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings/branch-triggers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId, values: { [key]: null } }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      setMessage(`ลบ override ${key} แล้ว`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <Link href="/admin/settings/communications" className="hover:text-green-700">
            Settings
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Branch triggers</span>
        </div>

        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">
            Branch trigger overrides
          </h1>
          <p className="text-xs text-gray-500">
            ตั้งค่าต่อสาขา — ค่าที่ไม่ override ใช้ HQ default. เปลี่ยนแล้วมีผลทันที (cache ~60s).
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

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <label className="block text-sm font-semibold text-gray-800">
            สาขา
          </label>
          <select
            value={branchId}
            onChange={(e) => {
              setBranchId(e.target.value);
              setDraft({});
            }}
            className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
          >
            <option value="">-- เลือกสาขา --</option>
            {ALL_BRANCHES.map((b) => (
              <option key={b.id} value={b.id}>
                {b.shortLabel}
              </option>
            ))}
          </select>
        </section>

        {branchId && (
          <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-2">
            {loading ? (
              <p className="text-sm text-gray-500">โหลด...</p>
            ) : (
              <>
                <QuietHoursPanel
                  startHour={
                    typeof draftValueFor("quiet_hours_start_h") === "number"
                      ? (draftValueFor("quiet_hours_start_h") as number)
                      : 9
                  }
                  endHour={
                    typeof draftValueFor("quiet_hours_end_h") === "number"
                      ? (draftValueFor("quiet_hours_end_h") as number)
                      : 19
                  }
                  enforced={draftValueFor("quiet_hours_enforced") === true}
                  startSource={effective.quiet_hours_start_h?.source ?? "default"}
                  endSource={effective.quiet_hours_end_h?.source ?? "default"}
                  enforcedSource={
                    effective.quiet_hours_enforced?.source ?? "default"
                  }
                  onChangeStart={(h) =>
                    setDraft({ ...draft, quiet_hours_start_h: h })
                  }
                  onChangeEnd={(h) =>
                    setDraft({ ...draft, quiet_hours_end_h: h })
                  }
                  onToggleEnforced={(v) =>
                    setDraft({ ...draft, quiet_hours_enforced: v })
                  }
                  onRevert={handleRevert}
                />
                <div className="divide-y divide-gray-100">
                {EDITABLE.filter(
                  (s) =>
                    s.key !== "quiet_hours_start_h" &&
                    s.key !== "quiet_hours_end_h" &&
                    s.key !== "quiet_hours_enforced"
                ).map((spec) => {
                  const eff = effective[spec.key];
                  const value = draftValueFor(spec.key);
                  const isOverride = eff?.source === "branch";
                  return (
                    <div
                      key={spec.key}
                      className="py-3 flex flex-wrap items-center justify-between gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-gray-900">
                          {spec.label}
                        </div>
                        <div className="text-[10px] text-gray-500">
                          <code>{spec.key}</code> ·{" "}
                          {isOverride ? "branch override" : "HQ default"}
                          {spec.hint && <> · {spec.hint}</>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {spec.kind === "number" ? (
                          <input
                            type="number"
                            inputMode="numeric"
                            value={
                              typeof value === "number"
                                ? value
                                : typeof value === "string"
                                  ? Number(value)
                                  : 0
                            }
                            onChange={(e) =>
                              setDraft({ ...draft, [spec.key]: Number(e.target.value) })
                            }
                            className="w-24 rounded-lg border border-gray-200 px-2 py-1 text-sm text-right"
                          />
                        ) : (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={value === true}
                            onClick={() =>
                              setDraft({ ...draft, [spec.key]: !(value === true) })
                            }
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
                        {isOverride && (
                          <button
                            type="button"
                            onClick={() => void handleRevert(spec.key)}
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
              </>
            )}

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
        )}
      </div>
    </div>
  );
}

/**
 * Phase 21 polish: dedicated quiet-hours block that:
 *  • shows the window as readable "HH:00 → HH:00 (Bangkok)"
 *  • uses HH-select inputs instead of raw number inputs
 *  • exposes the enforce toggle inline
 *  • highlights when current time falls inside the active window.
 */
function QuietHoursPanel({
  startHour,
  endHour,
  enforced,
  startSource,
  endSource,
  enforcedSource,
  onChangeStart,
  onChangeEnd,
  onToggleEnforced,
  onRevert,
}: {
  startHour: number;
  endHour: number;
  enforced: boolean;
  startSource: "branch" | "default";
  endSource: "branch" | "default";
  enforcedSource: "branch" | "default";
  onChangeStart: (h: number) => void;
  onChangeEnd: (h: number) => void;
  onToggleEnforced: (v: boolean) => void;
  onRevert: (key: string) => void;
}) {
  const formatHour = (h: number) =>
    `${String(h).padStart(2, "0")}:00`;
  const bangkokHour = useMemo(() => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Bangkok",
        hour: "numeric",
        hour12: false,
      }).formatToParts(new Date());
      return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
    } catch {
      return new Date().getHours();
    }
  }, []);
  const inWindow =
    enforced &&
    (startHour <= endHour
      ? bangkokHour >= startHour && bangkokHour < endHour
      : bangkokHour >= startHour || bangkokHour < endHour);

  const anyOverride =
    startSource === "branch" ||
    endSource === "branch" ||
    enforcedSource === "branch";

  return (
    <div className="py-3 border-b border-gray-100">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-900">
            Quiet hours (Bangkok time)
          </div>
          <div className="mt-0.5 text-[10px] text-gray-500">
            ส่งได้เฉพาะระหว่างชั่วโมงด้านล่าง · ปิด toggle เพื่อให้สาขานี้ส่ง 24/7
          </div>
          <div
            className={`mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
              !enforced
                ? "border-gray-200 bg-gray-50 text-gray-600"
                : inWindow
                  ? "border-green-300 bg-green-50 text-green-900"
                  : "border-amber-300 bg-amber-50 text-amber-900"
            }`}
          >
            <span className="font-semibold">
              {enforced
                ? `${formatHour(startHour)} → ${formatHour(endHour)}`
                : "24 / 7 (ไม่บังคับ)"}
            </span>
            {enforced && (
              <span className="text-[10px]">
                · ตอนนี้ที่กรุงเทพฯ {formatHour(bangkokHour)} · {inWindow ? "ในหน้าต่าง" : "นอกหน้าต่าง"}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enforced}
          onClick={() => onToggleEnforced(!enforced)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
            enforced ? "bg-green-600" : "bg-gray-300"
          }`}
          title="enforce quiet hours"
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              enforced ? "translate-x-5" : "translate-x-0.5"
            } self-center`}
          />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] font-semibold text-gray-700">
            เริ่ม{" "}
            <span className="text-[10px] font-normal text-gray-500">
              ({startSource === "branch" ? "branch override" : "HQ default"})
            </span>
          </span>
          <select
            value={startHour}
            onChange={(e) => onChangeStart(Number(e.target.value))}
            disabled={!enforced}
            className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1 text-sm disabled:bg-gray-100"
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {formatHour(h)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-gray-700">
            สิ้นสุด (exclusive){" "}
            <span className="text-[10px] font-normal text-gray-500">
              ({endSource === "branch" ? "branch override" : "HQ default"})
            </span>
          </span>
          <select
            value={endHour}
            onChange={(e) => onChangeEnd(Number(e.target.value))}
            disabled={!enforced}
            className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1 text-sm disabled:bg-gray-100"
          >
            {Array.from({ length: 25 }, (_, h) => (
              <option key={h} value={h}>
                {formatHour(h)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {anyOverride && (
        <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
          {startSource === "branch" && (
            <button
              type="button"
              onClick={() => onRevert("quiet_hours_start_h")}
              className="text-red-700 hover:text-red-900 underline"
            >
              revert start
            </button>
          )}
          {endSource === "branch" && (
            <button
              type="button"
              onClick={() => onRevert("quiet_hours_end_h")}
              className="text-red-700 hover:text-red-900 underline"
            >
              revert end
            </button>
          )}
          {enforcedSource === "branch" && (
            <button
              type="button"
              onClick={() => onRevert("quiet_hours_enforced")}
              className="text-red-700 hover:text-red-900 underline"
            >
              revert enforce toggle
            </button>
          )}
        </div>
      )}
    </div>
  );
}
