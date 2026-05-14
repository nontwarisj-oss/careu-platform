"use client";

// /admin/crm/audiences — segment builder + audience estimator.
//
// Standalone tool — operators iterate on segment filters and see the
// estimated audience without committing to a draft. The same form
// shape is used by /admin/crm/broadcasts when linked to a draft.
//
// NO SEND BUTTON. NO MASS-SEND PATH FROM HERE. Phase 15 contract:
// audience size + opt-in + branch breakdown + sample customers only.

import { useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";

type Segment = {
  branchSlugs: string[];
  tiers: string[];
  lifecycleStages: string[];
  customerTypes: string[];
  retentionScoreGte: number | null;
  totalSpendGte: number | null;
  totalOrdersGte: number | null;
  inactiveDaysGte: number | null;
  activeWithinDays: number | null;
  requireLineLink: boolean;
  requirePhone: boolean;
};

type Counts = {
  totalMatch: number;
  reachableLine: number;
  reachableSms: number;
  reachableEmail: number;
  optedOutLine: number;
  optedOutSms: number;
  optedOutEmail: number;
  distribution: {
    byBranch: Record<string, number>;
    byTier: Record<string, number>;
    byStage: Record<string, number>;
  };
  sample: Array<{ id: string; name: string; phoneMasked: string }>;
};

const TIERS = ["bronze", "silver", "gold", "platinum", "vip"];
const STAGES = ["new", "active", "reactivated", "at_risk", "dormant", "churned"];
const TYPES = ["new", "returning", "walk_in"];

const EMPTY_SEGMENT: Segment = {
  branchSlugs: [],
  tiers: [],
  lifecycleStages: [],
  customerTypes: [],
  retentionScoreGte: null,
  totalSpendGte: null,
  totalOrdersGte: null,
  inactiveDaysGte: null,
  activeWithinDays: null,
  requireLineLink: false,
  requirePhone: false,
};

export default function AudiencesPage() {
  return (
    <RouteGuard page="admin">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const [segment, setSegment] = useState<Segment>(EMPTY_SEGMENT);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEstimate = async () => {
    setBusy(true);
    setError(null);
    try {
      // Sanitise — convert empty strings to null so JSON has the
      // right type. The API tolerates null but rejects "".
      const payload = {
        segment: {
          ...segment,
          branchSlugs: segment.branchSlugs.filter(Boolean),
          tiers: segment.tiers,
          lifecycleStages: segment.lifecycleStages,
          customerTypes: segment.customerTypes,
        },
      };
      const res = await fetch("/api/admin/crm/audiences/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        counts?: Counts;
        estimatedCostThb?: number;
      };
      if (!res.ok || !json.ok || !json.counts) {
        setError(json.reason ?? `ประมาณการล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setCounts(json.counts);
      setCost(json.estimatedCostThb ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <Link href="/admin/crm/broadcasts" className="hover:text-green-700">
            CRM
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Audiences</span>
        </div>

        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">
            กลุ่มเป้าหมาย (Audience builder)
          </h1>
          <p className="text-sm text-gray-600">
            สร้าง segment + ประมาณการขนาด audience —{" "}
            <strong className="text-gray-800">ไม่ส่งจริง</strong> ในเฟสนี้
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="grid lg:grid-cols-2 gap-5">
          <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-4">
            <h2 className="text-base font-bold text-gray-900">Segment filter</h2>

            <MultiSelect
              label="Tiers"
              options={TIERS}
              value={segment.tiers}
              onChange={(v) => setSegment({ ...segment, tiers: v })}
            />
            <MultiSelect
              label="Lifecycle stages"
              options={STAGES}
              value={segment.lifecycleStages}
              onChange={(v) => setSegment({ ...segment, lifecycleStages: v })}
            />
            <MultiSelect
              label="Customer types"
              options={TYPES}
              value={segment.customerTypes}
              onChange={(v) => setSegment({ ...segment, customerTypes: v })}
            />

            <NumberField
              label="Retention score ≥"
              value={segment.retentionScoreGte}
              onChange={(v) =>
                setSegment({ ...segment, retentionScoreGte: v })
              }
            />
            <NumberField
              label="Total spend ≥ (฿)"
              value={segment.totalSpendGte}
              onChange={(v) => setSegment({ ...segment, totalSpendGte: v })}
            />
            <NumberField
              label="Total orders ≥"
              value={segment.totalOrdersGte}
              onChange={(v) => setSegment({ ...segment, totalOrdersGte: v })}
            />
            <NumberField
              label="Inactive ≥ (days)"
              value={segment.inactiveDaysGte}
              onChange={(v) => setSegment({ ...segment, inactiveDaysGte: v })}
            />
            <NumberField
              label="Active within (days)"
              value={segment.activeWithinDays}
              onChange={(v) => setSegment({ ...segment, activeWithinDays: v })}
            />

            <div className="flex flex-col gap-1.5">
              <CheckRow
                label="ต้องมี LINE link"
                checked={segment.requireLineLink}
                onChange={(v) =>
                  setSegment({ ...segment, requireLineLink: v })
                }
              />
              <CheckRow
                label="ต้องมีเบอร์โทร"
                checked={segment.requirePhone}
                onChange={(v) => setSegment({ ...segment, requirePhone: v })}
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setSegment(EMPTY_SEGMENT)}
                className="text-xs text-gray-500 hover:text-gray-800"
              >
                ล้างทั้งหมด
              </button>
              <button
                type="button"
                onClick={() => void handleEstimate()}
                disabled={busy}
                className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                {busy ? "กำลังประมาณ..." : "ประมาณการ"}
              </button>
            </div>
          </section>

          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-bold text-gray-900">ผลประมาณการ</h2>
            {!counts ? (
              <p className="mt-3 text-sm text-gray-500">
                ตั้งค่า segment + กดปุ่ม &quot;ประมาณการ&quot; เพื่อดูตัวเลข
              </p>
            ) : (
              <div className="mt-3 space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <Stat
                    label="ลูกค้าทั้งหมดในกลุ่ม"
                    value={counts.totalMatch.toLocaleString()}
                  />
                  <Stat
                    label="ค่าใช้จ่ายประมาณ (SMS)"
                    value={cost != null ? `฿${cost.toLocaleString()}` : "—"}
                  />
                  <Stat
                    label="ส่งได้ผ่าน SMS"
                    value={counts.reachableSms.toLocaleString()}
                    tone="green"
                  />
                  <Stat
                    label="ส่งได้ผ่าน LINE"
                    value={counts.reachableLine.toLocaleString()}
                    tone="green"
                  />
                  <Stat
                    label="ส่งได้ผ่านอีเมล"
                    value={counts.reachableEmail.toLocaleString()}
                  />
                  <Stat
                    label="opt-out SMS"
                    value={counts.optedOutSms.toLocaleString()}
                    tone="red"
                  />
                  <Stat
                    label="opt-out LINE"
                    value={counts.optedOutLine.toLocaleString()}
                    tone="red"
                  />
                  <Stat
                    label="opt-out อีเมล"
                    value={counts.optedOutEmail.toLocaleString()}
                    tone="red"
                  />
                </div>

                <DistributionBlock
                  label="แยกตามสาขา"
                  data={counts.distribution.byBranch}
                />
                <DistributionBlock
                  label="แยกตาม tier"
                  data={counts.distribution.byTier}
                />
                <DistributionBlock
                  label="แยกตาม stage"
                  data={counts.distribution.byStage}
                />

                {counts.sample.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-1">
                      ตัวอย่างลูกค้าในกลุ่ม (20 รายแรก)
                    </p>
                    <ul className="grid sm:grid-cols-2 gap-1 text-[11px] text-gray-700">
                      {counts.sample.map((c) => (
                        <li
                          key={c.id}
                          className="truncate rounded bg-gray-50 px-2 py-1"
                        >
                          {c.name}
                          <span className="text-gray-400 ml-1.5">
                            {c.phoneMasked}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <p className="text-[11px] text-gray-500 text-center">
          การ &quot;ส่งจริง&quot; (mass-send) ยังไม่เปิดในเฟสนี้ — ระบบยังไม่
          dispatch ข้อความให้ลูกค้าจากหน้านี้
        </p>
      </div>
    </div>
  );
}

function MultiSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const toggle = (opt: string) => {
    onChange(value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt]);
  };
  return (
    <div>
      <p className="text-[11px] font-semibold text-gray-700 mb-1">{label}</p>
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
              value.includes(opt)
                ? "border-green-500 bg-green-50 text-green-800"
                : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label className="text-[11px] font-semibold text-gray-700">{label}</label>
      <input
        type="number"
        inputMode="numeric"
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value.trim();
          onChange(v === "" ? null : Number(v));
        }}
        className="w-28 rounded-lg border border-gray-200 px-2 py-1 text-sm text-right"
      />
    </div>
  );
}

function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-green-700"
      />
      {label}
    </label>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "green" | "red";
}) {
  const valueClass =
    tone === "green"
      ? "text-green-800"
      : tone === "red"
        ? "text-red-700"
        : "text-gray-900";
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
        {label}
      </p>
      <p className={`mt-0.5 text-lg font-extrabold ${valueClass}`}>{value}</p>
    </div>
  );
}

function DistributionBlock({
  label,
  data,
}: {
  label: string;
  data: Record<string, number>;
}) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-1">
        {label}
      </p>
      <div className="space-y-1">
        {entries
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 text-[11px]">
              <span className="w-32 truncate text-gray-700">{k}</span>
              <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-green-500"
                  style={{ width: `${(v / max) * 100}%` }}
                />
              </div>
              <span className="w-10 text-right text-gray-600">{v}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
