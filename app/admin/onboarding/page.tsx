"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import supabase from "@/lib/supabase";
import { useLanguage } from "@/lib/languageContext";
import { useRole } from "@/lib/roleContext";
import { canManageStaff } from "@/lib/permissions";

type BranchRow = {
  id: string;
  code: string;
  short_code: string;
  name: string;
  type: string;
  brand: string | null;
  is_active: boolean;
  created_at: string;
};

type FormState = {
  code: string;
  short_code: string;
  name: string;
  type: "care_u" | "ezy_repair" | "mixed";
  brand: string;
  createLineConfig: boolean;
};

const EMPTY_FORM: FormState = {
  code: "",
  short_code: "",
  name: "",
  type: "mixed",
  brand: "",
  createLineConfig: true,
};

export default function OnboardingPage() {
  return (
    <RouteGuard page="admin">
      <OnboardingInner />
    </RouteGuard>
  );
}

function OnboardingInner() {
  const { language } = useLanguage();
  const { role } = useRole();
  const canEdit = canManageStaff(role);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadBranches = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("branches")
      .select("id, code, short_code, name, type, brand, is_active, created_at")
      .order("created_at", { ascending: false });
    if (error) {
      setError(error.message);
      setBranches([]);
    } else {
      setBranches((data ?? []) as BranchRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  const codeAvailable = useMemo(() => {
    const t = form.code.trim();
    if (!t) return null as null | boolean;
    return !branches.some((b) => b.code === t);
  }, [form.code, branches]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/onboarding/create-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: form.code.trim(),
          short_code: form.short_code.trim(),
          name: form.name.trim(),
          type: form.type,
          brand: form.brand.trim() || null,
          createLineConfig: form.createLineConfig,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        branch?: BranchRow;
      };
      if (!res.ok || !json.ok || !json.branch) {
        setError(json.reason ?? `HTTP ${res.status}`);
      } else {
        setMessage(
          language === "th"
            ? `สร้างสาขา "${json.branch.code}" สำเร็จ (ปิดใช้งานไว้ก่อน) — ทำตามขั้นตอนถัดไปก่อนเปิดใช้งาน`
            : `Created branch "${json.branch.code}" (inactive) — follow the next-steps before activation.`
        );
        setForm(EMPTY_FORM);
        await loadBranches();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    }
    setSubmitting(false);
  };

  const handleToggleActive = async (b: BranchRow, isActive: boolean) => {
    if (!canEdit) return;
    setActivatingId(b.id);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/onboarding/activate-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: b.id, isActive }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        branch?: { id: string; code: string; is_active: boolean };
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
      } else {
        setMessage(
          language === "th"
            ? `${isActive ? "เปิด" : "ปิด"}ใช้งานสาขา "${json.branch?.code}" เรียบร้อย`
            : `${isActive ? "Activated" : "Deactivated"} branch "${json.branch?.code}"`
        );
        await loadBranches();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    }
    setActivatingId(null);
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-4 flex items-center gap-2 text-xs text-gray-500">
        <Link href="/admin" className="hover:text-green-700">
          {language === "th" ? "ศูนย์จัดการระบบ" : "Admin centre"}
        </Link>
        <span>/</span>
        <span className="text-gray-700 font-medium">
          {language === "th" ? "เปิดสาขาใหม่" : "Branch onboarding"}
        </span>
      </div>

      <div className="mb-5 flex flex-col gap-2 border-l-4 border-yellow-400 pl-4">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
          CareU OPS
        </p>
        <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
          {language === "th" ? "เปิดสาขาใหม่ / Onboarding" : "Branch onboarding"}
        </h1>
        <p className="text-sm text-gray-600">
          {language === "th"
            ? "สร้างสาขาใหม่ในระบบ — สาขาจะถูกตั้งเป็น \"ปิดใช้งาน\" จนกว่าจะเปิดเอง (เพื่อความปลอดภัย)"
            : "Add a new branch. New branches start INACTIVE until explicitly activated (safety default)."}
        </p>
      </div>

      {message && (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 flex items-start justify-between gap-3">
          <span>{message}</span>
          <button
            type="button"
            onClick={() => setMessage(null)}
            className="text-green-700 hover:text-green-900"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-700 hover:text-red-900"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <form
        onSubmit={handleCreate}
        className="mb-6 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm space-y-4"
      >
        <h2 className="text-lg font-bold text-gray-900">
          {language === "th" ? "ขั้นที่ 1 — ข้อมูลสาขา" : "Step 1 — Branch basics"}
        </h2>

        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              {language === "th" ? "Branch code (slug)" : "Branch code (slug)"}
            </label>
            <input
              type="text"
              value={form.code}
              onChange={(e) =>
                setForm({ ...form, code: e.target.value.toLowerCase() })
              }
              placeholder="e.g. c24-thonburi-market"
              required
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-green-500"
            />
            {form.code && (
              <p
                className={`mt-1 text-[11px] ${
                  codeAvailable ? "text-green-700" : "text-red-700"
                }`}
              >
                {codeAvailable
                  ? language === "th"
                    ? "✓ ใช้ได้"
                    : "✓ available"
                  : language === "th"
                  ? "✗ code นี้มีอยู่แล้ว"
                  : "✗ code already exists"}
              </p>
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              {language === "th"
                ? "Short code (3 ตัว สำหรับ Job ID)"
                : "Short code (3 chars for Job ID)"}
            </label>
            <input
              type="text"
              value={form.short_code}
              onChange={(e) =>
                setForm({ ...form, short_code: e.target.value.toUpperCase() })
              }
              placeholder="SLM"
              required
              maxLength={8}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            {language === "th" ? "ชื่อเต็มสาขา" : "Full branch name"}
          </label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="C24 Care U - ทุ่งครุ"
            required
            className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              {language === "th" ? "ประเภทธุรกิจ" : "Business type"}
            </label>
            <select
              value={form.type}
              onChange={(e) =>
                setForm({
                  ...form,
                  type: e.target.value as FormState["type"],
                })
              }
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="mixed">Mixed (Care U + Ezy)</option>
              <option value="care_u">Care U</option>
              <option value="ezy_repair">Ezy Repair</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              {language === "th" ? "แบรนด์ (ไม่บังคับ)" : "Brand (optional)"}
            </label>
            <select
              value={form.brand}
              onChange={(e) => setForm({ ...form, brand: e.target.value })}
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="">—</option>
              <option value="careu">careu</option>
              <option value="ezy">ezy</option>
            </select>
          </div>
        </div>

        <h2 className="text-lg font-bold text-gray-900 pt-2">
          {language === "th"
            ? "ขั้นที่ 2 — เตรียมที่ว่างสำหรับการตั้งค่า"
            : "Step 2 — Reserve config slots"}
        </h2>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.createLineConfig}
            onChange={(e) =>
              setForm({ ...form, createLineConfig: e.target.checked })
            }
            className="w-4 h-4 accent-green-700"
          />
          <span className="text-sm text-gray-700">
            {language === "th"
              ? "สร้างแถวเปล่าใน branch_line_configs (พร้อมใส่ access token ทีหลัง)"
              : "Create an empty branch_line_configs row (LINE channel token can be filled in later)."}
          </span>
        </label>

        <h2 className="text-lg font-bold text-gray-900 pt-2">
          {language === "th"
            ? "ขั้นที่ 3 — สิ่งที่ต้องทำหลังกดสร้าง"
            : "Step 3 — Manual steps after create"}
        </h2>
        <ul className="text-xs text-gray-600 list-disc list-inside space-y-1">
          <li>
            {language === "th"
              ? "เพิ่มสาขาใน lib/brandConfig.ts เพื่อให้ UI label ตรง"
              : "Add an entry to lib/brandConfig.ts so UI labels mirror the branches table."}
          </li>
          <li>
            {language === "th"
              ? "เพิ่มพนักงานผ่าน /admin/staff และผูกกับสาขานี้"
              : "Add staff via /admin/staff and pin them to this branch."}
          </li>
          <li>
            {language === "th"
              ? "ถ้าใช้ LINE OA เฉพาะสาขา: UPDATE branch_line_configs.channel_access_token"
              : "If using a per-branch LINE OA: UPDATE branch_line_configs.channel_access_token."}
          </li>
          <li>
            {language === "th"
              ? "ตรวจสอบราคา service_prices — ถ้าใช้ราคากลางพอแล้ว ไม่ต้องทำอะไร"
              : "Review service_prices — if global pricing is sufficient, no action needed."}
          </li>
          <li>
            {language === "th"
              ? "กลับมาที่หน้านี้แล้วเปิดใช้งานสาขาจากตารางด้านล่าง"
              : "Return here and activate the branch from the table below."}
          </li>
        </ul>

        <div className="pt-2">
          <button
            type="submit"
            disabled={
              !canEdit ||
              submitting ||
              !form.code.trim() ||
              !form.short_code.trim() ||
              !form.name.trim() ||
              codeAvailable === false
            }
            className="rounded-xl bg-green-700 hover:bg-green-800 text-white font-semibold px-5 py-3 text-sm disabled:opacity-50 min-h-[44px]"
          >
            {submitting
              ? language === "th"
                ? "กำลังสร้าง..."
                : "Creating..."
              : language === "th"
              ? "สร้างสาขาใหม่ (inactive)"
              : "Create branch (inactive)"}
          </button>
        </div>
      </form>

      {/* Existing branches */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="p-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">
            {language === "th"
              ? "สาขาทั้งหมดในระบบ"
              : "All branches in the system"}
          </h2>
          <p className="text-xs text-gray-500">
            {language === "th"
              ? "สาขาใหม่ตั้งเป็น \"ปิดใช้งาน\" — กดเปิดเมื่อพร้อมรับงาน"
              : "New branches start inactive — activate when ready to accept orders."}
          </p>
        </div>
        {loading ? (
          <div className="p-8 text-center text-gray-500">
            {language === "th" ? "กำลังโหลด..." : "Loading..."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="text-left p-3">Code</th>
                  <th className="text-left p-3">Short</th>
                  <th className="text-left p-3">
                    {language === "th" ? "ชื่อ" : "Name"}
                  </th>
                  <th className="text-left p-3">Type</th>
                  <th className="text-left p-3">Brand</th>
                  <th className="text-left p-3">
                    {language === "th" ? "สถานะ" : "Status"}
                  </th>
                  <th className="text-right p-3"></th>
                </tr>
              </thead>
              <tbody>
                {branches.map((b) => (
                  <tr
                    key={b.id}
                    className="border-t border-gray-100 hover:bg-green-50/30"
                  >
                    <td className="p-3 font-mono text-[12px]">{b.code}</td>
                    <td className="p-3 font-mono text-[12px]">{b.short_code}</td>
                    <td className="p-3 text-gray-800">{b.name}</td>
                    <td className="p-3 text-gray-700">{b.type}</td>
                    <td className="p-3 text-gray-700">{b.brand ?? "—"}</td>
                    <td className="p-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          b.is_active
                            ? "border-green-200 bg-green-50 text-green-800"
                            : "border-gray-200 bg-gray-50 text-gray-600"
                        }`}
                      >
                        {b.is_active ? "active" : "inactive"}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <button
                        type="button"
                        onClick={() => void handleToggleActive(b, !b.is_active)}
                        disabled={!canEdit || activatingId === b.id}
                        className={`px-2.5 py-1 rounded-md border text-[11px] font-semibold disabled:opacity-50 ${
                          b.is_active
                            ? "border-red-200 bg-white text-red-700 hover:bg-red-50"
                            : "border-green-300 bg-white text-green-700 hover:bg-green-50"
                        }`}
                      >
                        {activatingId === b.id
                          ? "..."
                          : b.is_active
                          ? language === "th"
                            ? "ปิดใช้งาน"
                            : "Deactivate"
                          : language === "th"
                          ? "เปิดใช้งาน"
                          : "Activate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
