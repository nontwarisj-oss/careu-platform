"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import supabase from "@/lib/supabase";
import { useLanguage } from "@/lib/languageContext";
import { useRole } from "@/lib/roleContext";
import { canManageStaff } from "@/lib/permissions";
import { formatCurrency } from "@/lib/utils";
import {
  fetchBranchOptions,
  type BranchOption,
} from "@/lib/staffService";
import {
  calculateEstimatedPayroll,
  type EstimatedPayroll,
  type PayrollPeriodRow,
} from "@/lib/payrollService";
import {
  effectiveDailyTarget,
  type TechnicianProfile,
} from "@/lib/technicianService";

type DraftItem = {
  technicianProfileId: string;
  estimate: EstimatedPayroll;
  bonus: string;
  deduction: string;
  notes: string;
  /** True when an existing technician_payroll_items row was already saved. */
  saved: boolean;
};

export default function PayrollPage() {
  return (
    <RouteGuard page="admin">
      <PayrollInner />
    </RouteGuard>
  );
}

function PayrollInner() {
  const { language } = useLanguage();
  const { role } = useRole();
  const canEdit = canManageStaff(role);

  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [branchId, setBranchId] = useState<string>("");
  const [year, setYear] = useState<number>(new Date().getFullYear() + 543); // BE
  const [month, setMonth] = useState<number>(new Date().getMonth() + 1);

  const [period, setPeriod] = useState<PayrollPeriodRow | null>(null);
  const [technicians, setTechnicians] = useState<TechnicianProfile[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftItem>>({});

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  // CE year = BE − 543. Store BE for display but convert before DB ops.
  const yearCE = useMemo(() => year - 543, [year]);

  useEffect(() => {
    void (async () => {
      const opts = await fetchBranchOptions();
      setBranches(opts);
      if (opts.length > 0 && !branchId) setBranchId(opts[0].id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadPeriod = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setError(null);

    // 1. Look up the period (open + paid + finalized all show here).
    const periodRes = await supabase
      .from("payroll_periods")
      .select(
        "id, branch_id, year, month, start_date, end_date, status, finalized_at, paid_at, notes, created_at, updated_at"
      )
      .eq("branch_id", branchId)
      .eq("year", yearCE)
      .eq("month", month)
      .maybeSingle();
    const periodRow =
      periodRes.error || !periodRes.data
        ? null
        : (periodRes.data as PayrollPeriodRow);
    setPeriod(periodRow);

    // 2. Active technicians for the branch.
    const techRes = await supabase
      .from("technician_profiles")
      .select(
        "id, user_id, branch_id, display_name, active, skill_tags, daily_wage, target_multiplier, productivity_target, created_at, updated_at"
      )
      .eq("branch_id", branchId)
      .order("display_name", { ascending: true });
    const techList = (techRes.data ?? []) as TechnicianProfile[];
    setTechnicians(techList);

    // 3. Estimate each tech's payroll. KPI view reads inherit RLS.
    const draftMap: Record<string, DraftItem> = {};
    await Promise.all(
      techList.map(async (tech) => {
        const estimate = await calculateEstimatedPayroll(tech, yearCE, month);
        draftMap[tech.id] = {
          technicianProfileId: tech.id,
          estimate,
          bonus: "0",
          deduction: "0",
          notes: "",
          saved: false,
        };
      })
    );

    // 4. If a period exists, hydrate any saved items.
    if (periodRow) {
      const itemsRes = await supabase
        .from("technician_payroll_items")
        .select(
          "id, payroll_period_id, technician_profile_id, base_wage, days_worked, production_value, target_value, performance_ratio, bonus_amount, deduction_amount, final_pay, notes, daily_wage_snapshot, target_multiplier_snapshot"
        )
        .eq("payroll_period_id", periodRow.id);
      for (const row of (itemsRes.data ?? []) as Array<{
        technician_profile_id: string;
        bonus_amount: number;
        deduction_amount: number;
        notes: string | null;
      }>) {
        const draft = draftMap[row.technician_profile_id];
        if (!draft) continue;
        draft.bonus = String(row.bonus_amount ?? 0);
        draft.deduction = String(row.deduction_amount ?? 0);
        draft.notes = row.notes ?? "";
        draft.saved = true;
      }
    }
    setDrafts(draftMap);
    setLoading(false);
  }, [branchId, yearCE, month]);

  useEffect(() => {
    if (branchId) void loadPeriod();
  }, [branchId, yearCE, month, loadPeriod]);

  const handleOpenPeriod = async () => {
    if (!canEdit) return;
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/payroll/open-period", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId, year: yearCE, month }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        period?: PayrollPeriodRow;
        reason?: string;
      };
      if (!res.ok || !json.ok || !json.period) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      setPeriod(json.period);
      setMessage(
        language === "th"
          ? "เปิด period สำเร็จ"
          : "Payroll period opened"
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    }
  };

  const handleSaveItem = async (techId: string) => {
    if (!canEdit || !period) return;
    const draft = drafts[techId];
    if (!draft) return;
    setSavingId(techId);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/payroll/save-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payrollPeriodId: period.id,
          technicianProfileId: techId,
          baseWage: draft.estimate.baseWage,
          dailyWageSnapshot: draft.estimate.dailyWageSnapshot,
          targetMultiplierSnapshot: draft.estimate.targetMultiplierSnapshot,
          daysWorked: draft.estimate.daysWorked,
          productionValue: draft.estimate.productionValue,
          targetValue: draft.estimate.targetValue,
          performanceRatio: draft.estimate.performanceRatio,
          bonusAmount: Number(draft.bonus) || 0,
          deductionAmount: Number(draft.deduction) || 0,
          notes: draft.notes || null,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
      } else {
        setDrafts((prev) => ({
          ...prev,
          [techId]: { ...prev[techId], saved: true },
        }));
        setMessage(
          language === "th"
            ? "บันทึกรายการช่างเรียบร้อย"
            : "Technician item saved"
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    }
    setSavingId(null);
  };

  const handleTransition = async (to: "finalized" | "paid") => {
    if (!canEdit || !period) return;
    if (
      !window.confirm(
        to === "finalized"
          ? language === "th"
            ? "ยืนยันการ Finalize period นี้? หลัง finalize สามารถแก้ไข bonus/deduction ได้ แต่ต้อง finalize ก่อนจึงจะ \"จ่ายแล้ว\" ได้"
            : "Finalize this period? Bonus/deduction stay editable; payouts can only be marked after finalize."
          : language === "th"
          ? "ยืนยัน \"จ่ายเงินแล้ว\"? หลังกดแล้วจะแก้ไขรายการช่างไม่ได้อีก"
          : "Mark as paid? After this, technician items become immutable."
      )
    )
      return;
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/payroll/transition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodId: period.id, to }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        period?: PayrollPeriodRow;
        reason?: string;
      };
      if (!res.ok || !json.ok || !json.period) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      setPeriod(json.period);
      setMessage(
        to === "paid"
          ? language === "th"
            ? "ทำเครื่องหมายว่าจ่ายเงินเรียบร้อย"
            : "Marked paid"
          : language === "th"
          ? "Finalize เรียบร้อย"
          : "Finalized"
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    }
  };

  const totals = useMemo(() => {
    let base = 0;
    let bonus = 0;
    let deduction = 0;
    let final = 0;
    let production = 0;
    let target = 0;
    let aboveCount = 0;
    for (const tech of technicians) {
      const draft = drafts[tech.id];
      if (!draft) continue;
      base += draft.estimate.baseWage;
      bonus += Number(draft.bonus) || 0;
      deduction += Number(draft.deduction) || 0;
      final += draft.estimate.baseWage + Number(draft.bonus) - Number(draft.deduction);
      production += draft.estimate.productionValue;
      target += draft.estimate.targetValue;
      if (draft.estimate.aboveTarget) aboveCount += 1;
    }
    return {
      techCount: technicians.length,
      base,
      bonus,
      deduction,
      final,
      production,
      target,
      aboveCount,
      ratio: target > 0 ? production / target : 0,
    };
  }, [drafts, technicians]);

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-4 flex items-center gap-2 text-xs text-gray-500">
        <Link href="/admin" className="hover:text-green-700">
          {language === "th" ? "ศูนย์จัดการระบบ" : "Admin centre"}
        </Link>
        <span>/</span>
        <span className="text-gray-700 font-medium">
          {language === "th" ? "เงินเดือนช่าง" : "Payroll"}
        </span>
      </div>

      <div className="mb-5 flex flex-col gap-2 border-l-4 border-yellow-400 pl-4">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
          CareU OPS
        </p>
        <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
          {language === "th" ? "เงินเดือนช่างซ่อม" : "Technician payroll"}
        </h1>
        <p className="text-sm text-gray-600">
          {language === "th"
            ? "ดูประมาณการรายเดือน · ปรับ bonus / deduction · finalize → ทำเครื่องหมายจ่ายแล้ว — เฉพาะ Owner / HQ Admin"
            : "Preview monthly estimates · adjust bonus / deduction · finalize → mark paid — Owner / HQ Admin only."}
        </p>
      </div>

      <div className="grid sm:grid-cols-4 gap-2 mb-4">
        <select
          value={branchId}
          onChange={(e) => setBranchId(e.target.value)}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
        >
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.shortCode ? `${b.shortCode} • ` : ""}
              {b.name}
            </option>
          ))}
        </select>
        <input
          type="number"
          value={year}
          onChange={(e) => setYear(Number(e.target.value) || year)}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
          aria-label={language === "th" ? "ปี (พ.ศ.)" : "Year (BE)"}
        />
        <select
          value={month}
          onChange={(e) => setMonth(Number(e.target.value))}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>
              {language === "th" ? `เดือน ${m}` : `Month ${m}`}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void loadPeriod()}
          disabled={loading}
          className="rounded-xl border border-green-300 bg-white px-3 py-2 text-sm font-semibold text-green-700 hover:bg-green-50 disabled:opacity-60"
        >
          {language === "th" ? "โหลดใหม่" : "Reload"}
        </button>
      </div>

      {/* Period status row */}
      <div className="mb-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        {period ? (
          <PeriodStatus
            period={period}
            language={language}
            canEdit={canEdit}
            onFinalize={() => void handleTransition("finalized")}
            onMarkPaid={() => void handleTransition("paid")}
          />
        ) : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-700">
              {language === "th"
                ? `ยังไม่มี period สำหรับสาขานี้ในเดือน ${month}/${yearCE} — กดเปิดเพื่อเริ่มประมวลผล`
                : `No period yet for ${month}/${yearCE} — open one to start.`}
            </span>
            <button
              type="button"
              onClick={() => void handleOpenPeriod()}
              disabled={!canEdit}
              className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {language === "th" ? "เปิด period" : "Open period"}
            </button>
          </div>
        )}
      </div>

      {message && (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 flex items-start justify-between gap-3">
          <span>{message}</span>
          <button onClick={() => setMessage(null)} className="text-green-700">
            ✕
          </button>
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-700">
            ✕
          </button>
        </div>
      )}

      {/* Totals */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        <SummaryCard
          label={language === "th" ? "ช่าง" : "Technicians"}
          value={String(totals.techCount)}
          tone="blue"
        />
        <SummaryCard
          label={language === "th" ? "ค่าแรงพื้นฐาน" : "Base wage"}
          value={formatCurrency(totals.base)}
          tone="gray"
        />
        <SummaryCard
          label={language === "th" ? "Final pay" : "Final pay"}
          value={formatCurrency(totals.final)}
          tone="green"
        />
        <SummaryCard
          label={language === "th" ? "ผลิต / เป้า" : "Production / target"}
          value={`${formatCurrency(totals.production)} / ${formatCurrency(totals.target)}`}
          tone="yellow"
        />
        <SummaryCard
          label={language === "th" ? "อัตราส่วน" : "Ratio"}
          value={`${(totals.ratio * 100).toFixed(0)} %`}
          tone="purple"
        />
      </div>

      {/* Items table */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500">
            {language === "th" ? "กำลังโหลด..." : "Loading..."}
          </div>
        ) : technicians.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {language === "th"
              ? "ยังไม่มีช่างซ่อมในสาขานี้ — เพิ่มที่ /admin/staff"
              : "No technicians in this branch — add via /admin/staff."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="text-left p-3">
                    {language === "th" ? "ช่าง" : "Technician"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "ค่าแรง/วัน" : "Wage/d"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "วันทำงาน" : "Days"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "ผลิต / เป้า" : "Prod / Target"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "Base" : "Base"}
                  </th>
                  <th className="text-left p-3">Bonus</th>
                  <th className="text-left p-3">Deduction</th>
                  <th className="text-left p-3">
                    {language === "th" ? "Final" : "Final"}
                  </th>
                  <th className="text-right p-3"></th>
                </tr>
              </thead>
              <tbody>
                {technicians.map((tech) => {
                  const draft = drafts[tech.id];
                  if (!draft) return null;
                  const final =
                    draft.estimate.baseWage +
                    (Number(draft.bonus) || 0) -
                    (Number(draft.deduction) || 0);
                  const target = effectiveDailyTarget(tech);
                  const disabled =
                    !canEdit ||
                    !period ||
                    period.status === "paid" ||
                    savingId === tech.id;
                  return (
                    <tr
                      key={tech.id}
                      className="border-t border-gray-100 align-top hover:bg-green-50/30"
                    >
                      <td className="p-3">
                        <p className="font-semibold text-gray-900">
                          {tech.display_name}
                        </p>
                        <p className="text-[11px] text-gray-500">
                          {tech.active
                            ? language === "th"
                              ? "ใช้งาน"
                              : "active"
                            : language === "th"
                            ? "ปิดใช้งาน"
                            : "inactive"}
                          {draft.estimate.aboveTarget && (
                            <span className="ml-2 inline-flex rounded-full border border-green-200 bg-green-50 text-green-800 px-1.5 py-0.5 text-[10px]">
                              {language === "th" ? "ถึงเป้า" : "above target"}
                            </span>
                          )}
                          {draft.saved && (
                            <span className="ml-2 inline-flex rounded-full border border-blue-200 bg-blue-50 text-blue-800 px-1.5 py-0.5 text-[10px]">
                              {language === "th" ? "บันทึกแล้ว" : "saved"}
                            </span>
                          )}
                        </p>
                      </td>
                      <td className="p-3 text-gray-800">
                        {formatCurrency(Number(tech.daily_wage ?? 0))}
                        <span className="block text-[10px] text-gray-500">
                          {language === "th" ? "เป้า/วัน" : "target/d"}{" "}
                          {formatCurrency(target)}
                        </span>
                      </td>
                      <td className="p-3 text-gray-800">
                        {draft.estimate.daysWorked}
                      </td>
                      <td className="p-3 text-gray-800">
                        {formatCurrency(draft.estimate.productionValue)}
                        <span className="block text-[10px] text-gray-500">
                          / {formatCurrency(draft.estimate.targetValue)}
                          {" · "}
                          {(draft.estimate.performanceRatio * 100).toFixed(0)} %
                        </span>
                      </td>
                      <td className="p-3 text-gray-900 font-medium">
                        {formatCurrency(draft.estimate.baseWage)}
                      </td>
                      <td className="p-3">
                        <input
                          type="number"
                          value={draft.bonus}
                          onChange={(e) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [tech.id]: {
                                ...prev[tech.id],
                                bonus: e.target.value,
                              },
                            }))
                          }
                          disabled={disabled}
                          className="w-24 rounded-lg border border-gray-200 px-2 py-1 outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                        />
                      </td>
                      <td className="p-3">
                        <input
                          type="number"
                          value={draft.deduction}
                          onChange={(e) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [tech.id]: {
                                ...prev[tech.id],
                                deduction: e.target.value,
                              },
                            }))
                          }
                          disabled={disabled}
                          className="w-24 rounded-lg border border-gray-200 px-2 py-1 outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                        />
                      </td>
                      <td className="p-3 text-gray-900 font-semibold">
                        {formatCurrency(final)}
                      </td>
                      <td className="p-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => void handleSaveItem(tech.id)}
                          disabled={disabled || !period}
                          className="px-2.5 py-1 rounded-md border border-green-300 bg-white text-[11px] font-semibold text-green-700 hover:bg-green-50 disabled:opacity-50"
                        >
                          {savingId === tech.id
                            ? language === "th"
                              ? "..."
                              : "..."
                            : language === "th"
                            ? "บันทึก"
                            : "Save"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function PeriodStatus({
  period,
  language,
  canEdit,
  onFinalize,
  onMarkPaid,
}: {
  period: PayrollPeriodRow;
  language: "th" | "en";
  canEdit: boolean;
  onFinalize: () => void;
  onMarkPaid: () => void;
}) {
  const statusTone: Record<PayrollPeriodRow["status"], string> = {
    open: "border-yellow-200 bg-yellow-50 text-yellow-800",
    finalized: "border-blue-200 bg-blue-50 text-blue-800",
    paid: "border-green-200 bg-green-50 text-green-800",
    cancelled: "border-gray-200 bg-gray-50 text-gray-600",
  };
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div>
        <p className="text-xs uppercase tracking-widest text-gray-500">
          {language === "th" ? "สถานะ" : "Status"}
        </p>
        <p className="mt-0.5 text-sm font-semibold text-gray-900">
          {period.year}/{String(period.month).padStart(2, "0")}{" "}
          <span
            className={`ml-2 inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
              statusTone[period.status]
            }`}
          >
            {period.status}
          </span>
        </p>
        <p className="text-[11px] text-gray-500 mt-0.5">
          {period.start_date} → {period.end_date}
          {period.finalized_at &&
            ` · ${language === "th" ? "finalize" : "finalized"} ${period.finalized_at.slice(
              0,
              10
            )}`}
          {period.paid_at && ` · ${language === "th" ? "paid" : "paid"} ${period.paid_at.slice(0, 10)}`}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onFinalize}
          disabled={!canEdit || period.status !== "open"}
          className="rounded-xl border border-blue-300 bg-white px-3 py-2 text-sm font-semibold text-blue-800 hover:bg-blue-50 disabled:opacity-50"
        >
          {language === "th" ? "Finalize" : "Finalize"}
        </button>
        <button
          type="button"
          onClick={onMarkPaid}
          disabled={!canEdit || period.status !== "finalized"}
          className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {language === "th" ? "จ่ายเงินแล้ว" : "Mark paid"}
        </button>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "blue" | "green" | "yellow" | "gray" | "purple";
}) {
  const toneClass = {
    blue: "border-blue-100 bg-blue-50 text-blue-900",
    green: "border-green-100 bg-green-50 text-green-900",
    yellow: "border-yellow-100 bg-yellow-50 text-yellow-900",
    gray: "border-gray-100 bg-gray-50 text-gray-700",
    purple: "border-purple-100 bg-purple-50 text-purple-900",
  }[tone];
  return (
    <div className={`rounded-2xl border ${toneClass} p-4 shadow-sm`}>
      <p className="text-xs opacity-80">{label}</p>
      <p className="mt-1 text-lg font-bold">{value}</p>
    </div>
  );
}
