"use client";

// /admin/system/guardrails — owner-only safety controls.
//
// Renders:
//   • Big red EMERGENCY STOP toggle at the top.
//   • Per-guardrail editor below: global row + optional per-branch
//     overrides for the cap-style keys.
//
// All edits go through /api/admin/system/guardrails.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { branches as ALL_BRANCHES } from "@/lib/brandConfig";

type Row = {
  id: string;
  key: string;
  value: unknown;
  branch_id: string | null;
  notes: string | null;
  updated_at: string;
};

const EDITABLE: Array<{
  key: string;
  label: string;
  kind: "number" | "boolean";
  branchAware: boolean;
}> = [
  {
    key: "global_emergency_stop",
    label: "Global emergency stop",
    kind: "boolean",
    branchAware: false,
  },
  {
    key: "max_sends_per_day_global",
    label: "Max sends per day (global)",
    kind: "number",
    branchAware: false,
  },
  {
    key: "max_sends_per_day_branch",
    label: "Max sends per day (per branch)",
    kind: "number",
    branchAware: true,
  },
  {
    key: "max_campaigns_per_week_branch",
    label: "Max campaigns per week (per branch)",
    kind: "number",
    branchAware: true,
  },
  {
    key: "dry_run_required",
    label: "Require dry-run before live broadcast",
    kind: "boolean",
    branchAware: true,
  },
];

export default function GuardrailsPage() {
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
  const [branchId, setBranchId] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/system/guardrails", {
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

  const writeOne = async (
    key: string,
    value: unknown,
    targetBranch: string | null
  ) => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/system/guardrails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: targetBranch, values: { [key]: value } }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      setMessage(`บันทึก ${key} แล้ว`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  const valueFor = (key: string, target: string | null): unknown => {
    const row = rows.find(
      (r) => r.key === key && r.branch_id === target
    );
    return row?.value;
  };

  const emergencyOn = valueFor("global_emergency_stop", null) === true;

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
          <span className="text-gray-700 font-medium">Guardrails</span>
        </div>

        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">
            Engagement guardrails
          </h1>
          <p className="text-xs text-gray-500">
            Owner-managed safety layer. Emergency stop halts ALL outbound
            sends instantly.
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

        {/* Big emergency-stop banner */}
        <section
          className={`rounded-2xl border-2 p-5 ${
            emergencyOn
              ? "border-red-500 bg-red-50"
              : "border-gray-200 bg-white"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                className={`text-lg font-extrabold ${
                  emergencyOn ? "text-red-900" : "text-gray-900"
                }`}
              >
                {emergencyOn ? "⛔ Outbound sends are HALTED" : "Emergency stop"}
              </h2>
              <p className="mt-1 text-xs text-gray-700">
                {emergencyOn
                  ? "Dispatch worker + retention engine + broadcast scheduler will refuse to send anything until this is cleared."
                  : "Flip this when something is wrong — every outbound path halts within ~60s."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                const confirmMsg = emergencyOn
                  ? "Resume all outbound sends?"
                  : "STOP all outbound sends? Dispatch + retention + broadcast workers will halt within 60s.";
                if (!window.confirm(confirmMsg)) return;
                void writeOne("global_emergency_stop", !emergencyOn, null);
              }}
              disabled={saving}
              className={`rounded-xl px-4 py-3 text-sm font-bold disabled:opacity-50 ${
                emergencyOn
                  ? "bg-green-700 hover:bg-green-800 text-white"
                  : "bg-red-700 hover:bg-red-800 text-white"
              }`}
            >
              {emergencyOn ? "Resume sends" : "STOP all sends"}
            </button>
          </div>
        </section>

        {/* Per-row controls */}
        <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
          <h2 className="text-base font-bold text-gray-900">Caps + flags</h2>
          {loading ? (
            <p className="text-sm text-gray-500">โหลด...</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {EDITABLE.filter((e) => e.key !== "global_emergency_stop").map(
                (spec) => (
                  <GuardrailRow
                    key={spec.key}
                    spec={spec}
                    rows={rows}
                    selectedBranch={branchId}
                    onBranchChange={setBranchId}
                    onSave={(value, target) =>
                      void writeOne(spec.key, value, target)
                    }
                    saving={saving}
                  />
                )
              )}
            </div>
          )}
        </section>

        <p className="text-[11px] text-gray-500 text-center">
          ทุกการเปลี่ยนแปลงถูก audit ลงใน cron_heartbeat_logs (kind=
          settings-edit).
        </p>
      </div>
    </div>
  );
}

function GuardrailRow({
  spec,
  rows,
  selectedBranch,
  onBranchChange,
  onSave,
  saving,
}: {
  spec: { key: string; label: string; kind: "number" | "boolean"; branchAware: boolean };
  rows: Row[];
  selectedBranch: string;
  onBranchChange: (b: string) => void;
  onSave: (value: unknown, target: string | null) => void;
  saving: boolean;
}) {
  const target = spec.branchAware && selectedBranch ? selectedBranch : null;
  const existing = rows.find(
    (r) => r.key === spec.key && r.branch_id === target
  );
  const initialValue = existing?.value;
  const [draft, setDraft] = useState<unknown>(initialValue);

  // re-sync when the target changes.
  const targetSignature = `${spec.key}::${target ?? "global"}`;
  useEffect(() => {
    setDraft(initialValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSignature]);

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-900">{spec.label}</div>
          <div className="text-[10px] text-gray-500">
            <code>{spec.key}</code>
            {spec.branchAware && (target ? ` · branch: ${target}` : " · GLOBAL")}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {spec.branchAware && (
            <select
              value={selectedBranch}
              onChange={(e) => onBranchChange(e.target.value)}
              className="rounded-lg border border-gray-200 px-2 py-1 text-xs"
            >
              <option value="">Global</option>
              {ALL_BRANCHES.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.shortLabel}
                </option>
              ))}
            </select>
          )}
          {spec.kind === "number" ? (
            <input
              type="number"
              inputMode="numeric"
              value={
                typeof draft === "number"
                  ? draft
                  : typeof draft === "string"
                    ? Number(draft)
                    : 0
              }
              onChange={(e) => setDraft(Number(e.target.value))}
              className="w-24 rounded-lg border border-gray-200 px-2 py-1 text-sm text-right"
            />
          ) : (
            <button
              type="button"
              role="switch"
              aria-checked={draft === true}
              onClick={() => setDraft(!(draft === true))}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
                draft === true ? "bg-green-600" : "bg-gray-300"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                  draft === true ? "translate-x-5" : "translate-x-0.5"
                } self-center`}
              />
            </button>
          )}
          <button
            type="button"
            onClick={() => onSave(draft, target)}
            disabled={saving}
            className="rounded-md border border-green-200 bg-green-50 hover:bg-green-100 text-green-800 px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
          >
            {saving ? "..." : "Save"}
          </button>
          {existing && (
            <button
              type="button"
              onClick={() => onSave(null, target)}
              disabled={saving}
              className="text-[10px] text-red-700 hover:text-red-900 underline whitespace-nowrap"
            >
              clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
