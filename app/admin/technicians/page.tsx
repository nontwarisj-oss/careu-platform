"use client";

// Phase J — /admin/technicians. Manage technicians (reuses
// technician_profiles) + their technician_skills. Owner / Admin only.

import { useCallback, useEffect, useState } from "react";
import { RouteGuard } from "@/components/RouteGuard";
import { Modal } from "@/components/Modal";
import { formatCurrency } from "@/lib/utils";
import { SKILL_LEVELS } from "@/lib/productionQueue";

type Skill = {
  id: string;
  categoryTh: string | null;
  subcategoryTh: string | null;
  serviceCode: string | null;
  skillLevel: string;
  preferred: boolean;
};
type Technician = {
  id: string;
  branchId: string | null;
  displayName: string;
  phone: string | null;
  active: boolean;
  employmentType: string | null;
  dailyWage: number | null;
  monthlySalary: number | null;
  targetMultiplier: number;
  dailyCapacityItems: number | null;
  note: string | null;
  skills: Skill[];
};
type Branch = { id: string; code: string; name: string };

type TechForm = {
  id?: string;
  displayName: string;
  phone: string;
  branchId: string;
  active: boolean;
  employmentType: string;
  dailyWage: string;
  monthlySalary: string;
  targetMultiplier: string;
  dailyCapacityItems: string;
  note: string;
};

const EMPTY_FORM: TechForm = {
  displayName: "",
  phone: "",
  branchId: "",
  active: true,
  employmentType: "",
  dailyWage: "",
  monthlySalary: "",
  targetMultiplier: "3",
  dailyCapacityItems: "",
  note: "",
};

export default function TechniciansPage() {
  return (
    <RouteGuard page="admin">
      <TechniciansInner />
    </RouteGuard>
  );
}

function TechniciansInner() {
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<TechForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/technicians");
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        technicians?: Technician[];
        branches?: Branch[];
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `โหลดไม่สำเร็จ (HTTP ${res.status})`);
      } else {
        setTechnicians(json.technicians ?? []);
        setBranches(json.branches ?? []);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "โหลดข้อมูลช่างไม่สำเร็จ");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };
  const openEdit = (t: Technician) => {
    setForm({
      id: t.id,
      displayName: t.displayName,
      phone: t.phone ?? "",
      branchId: t.branchId ?? "",
      active: t.active,
      employmentType: t.employmentType ?? "",
      dailyWage: t.dailyWage != null ? String(t.dailyWage) : "",
      monthlySalary: t.monthlySalary != null ? String(t.monthlySalary) : "",
      targetMultiplier: String(t.targetMultiplier ?? 3),
      dailyCapacityItems:
        t.dailyCapacityItems != null ? String(t.dailyCapacityItems) : "",
      note: t.note ?? "",
    });
    setModalOpen(true);
  };

  const post = async (body: Record<string, unknown>): Promise<boolean> => {
    const res = await fetch("/api/admin/technicians", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) {
      setError(json.error ?? "บันทึกไม่สำเร็จ");
      return false;
    }
    setError(null);
    return true;
  };

  const handleSave = async () => {
    if (!form.displayName.trim()) {
      setError("ต้องระบุชื่อช่าง");
      return;
    }
    setSaving(true);
    const ok = await post({
      action: "saveTechnician",
      technician: {
        id: form.id,
        displayName: form.displayName.trim(),
        phone: form.phone.trim() || null,
        branchId: form.branchId || null,
        active: form.active,
        employmentType: form.employmentType.trim() || null,
        dailyWage: form.dailyWage ? Number(form.dailyWage) : null,
        monthlySalary: form.monthlySalary ? Number(form.monthlySalary) : null,
        targetMultiplier: form.targetMultiplier
          ? Number(form.targetMultiplier)
          : 3,
        dailyCapacityItems: form.dailyCapacityItems
          ? Number(form.dailyCapacityItems)
          : null,
        note: form.note.trim() || null,
      },
    });
    setSaving(false);
    if (ok) {
      setModalOpen(false);
      setMessage(form.id ? "บันทึกข้อมูลช่างแล้ว" : "เพิ่มช่างแล้ว");
      await load();
    }
  };

  const branchName = (id: string | null) =>
    id ? branches.find((b) => b.id === id)?.name ?? id : "ทุกสาขา";

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-5 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 border-l-4 border-yellow-400 pl-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS
          </p>
          <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
            ช่าง / ทีมผลิต
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            จัดการช่าง ทักษะ ค่าแรง และเป้าหมายงานต่อวัน
          </p>
        </div>
        <button
          onClick={openAdd}
          className="self-start rounded-lg bg-green-700 px-5 py-2.5 font-semibold text-white hover:bg-green-800"
        >
          + เพิ่มช่าง
        </button>
      </div>

      {message && (
        <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800 flex justify-between">
          <span>{message}</span>
          <button onClick={() => setMessage(null)} aria-label="dismiss">
            ✕
          </button>
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center text-gray-500">
          กำลังโหลด...
        </div>
      ) : technicians.length === 0 ? (
        <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center text-gray-500">
          ยังไม่มีช่าง — กด “+ เพิ่มช่าง” เพื่อเริ่ม
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {technicians.map((t) => (
            <TechnicianCard
              key={t.id}
              tech={t}
              branchName={branchName(t.branchId)}
              onEdit={() => openEdit(t)}
              onChanged={load}
              onError={setError}
            />
          ))}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={form.id ? "แก้ไขช่าง" : "เพิ่มช่าง"}
        onSubmit={saving ? undefined : handleSave}
        submitLabel={saving ? "กำลังบันทึก..." : "บันทึก"}
      >
        <div className="space-y-3">
          <Field label="ชื่อช่าง">
            <input
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              className={inputCls}
              placeholder="ชื่อช่าง"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="เบอร์โทร">
              <input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label="สาขา">
              <select
                value={form.branchId}
                onChange={(e) =>
                  setForm({ ...form, branchId: e.target.value })
                }
                className={inputCls}
              >
                <option value="">— ทุกสาขา —</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="ประเภทการจ้าง">
              <input
                value={form.employmentType}
                onChange={(e) =>
                  setForm({ ...form, employmentType: e.target.value })
                }
                className={inputCls}
                placeholder="รายวัน / รายเดือน"
              />
            </Field>
            <Field label="ค่าแรงต่อวัน (฿)">
              <input
                type="number"
                value={form.dailyWage}
                onChange={(e) =>
                  setForm({ ...form, dailyWage: e.target.value })
                }
                className={inputCls}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="เงินเดือน (฿)">
              <input
                type="number"
                value={form.monthlySalary}
                onChange={(e) =>
                  setForm({ ...form, monthlySalary: e.target.value })
                }
                className={inputCls}
              />
            </Field>
            <Field label="ตัวคูณเป้าหมาย (x ค่าแรง)">
              <input
                type="number"
                value={form.targetMultiplier}
                onChange={(e) =>
                  setForm({ ...form, targetMultiplier: e.target.value })
                }
                className={inputCls}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="โควตางานต่อวัน (ชิ้น)">
              <input
                type="number"
                value={form.dailyCapacityItems}
                onChange={(e) =>
                  setForm({ ...form, dailyCapacityItems: e.target.value })
                }
                className={inputCls}
              />
            </Field>
            <Field label="สถานะ">
              <label className="flex items-center gap-2 pt-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) =>
                    setForm({ ...form, active: e.target.checked })
                  }
                  className="h-4 w-4 accent-green-700"
                />
                ใช้งาน (active)
              </label>
            </Field>
          </div>
          <Field label="หมายเหตุ">
            <textarea
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              rows={2}
              className={inputCls}
            />
          </Field>
          {form.dailyWage && (
            <p className="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-xs text-green-800">
              เป้าหมายค่างานต่อวัน ={" "}
              {formatCurrency(
                Number(form.dailyWage || 0) *
                  Number(form.targetMultiplier || 3)
              )}{" "}
              ({form.targetMultiplier || 3}× ค่าแรง)
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">
        {label}
      </span>
      {children}
    </label>
  );
}

function TechnicianCard({
  tech,
  branchName,
  onEdit,
  onChanged,
  onError,
}: {
  tech: Technician;
  branchName: string;
  onEdit: () => void;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [skill, setSkill] = useState({
    categoryTh: "",
    subcategoryTh: "",
    serviceCode: "",
    skillLevel: "STANDARD",
    preferred: false,
  });
  const [busy, setBusy] = useState(false);

  const target =
    tech.dailyWage != null
      ? tech.dailyWage * (tech.targetMultiplier || 3)
      : null;

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/technicians", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        onError(json.error ?? "ดำเนินการไม่สำเร็จ");
      } else {
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-lg font-bold text-gray-900">
            {tech.displayName}
            {!tech.active && (
              <span className="ml-2 rounded-full bg-gray-100 border border-gray-300 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
                ปิดใช้งาน
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500">
            {branchName}
            {tech.phone ? ` · ${tech.phone}` : ""}
            {tech.employmentType ? ` · ${tech.employmentType}` : ""}
          </p>
        </div>
        <button
          onClick={onEdit}
          className="rounded-lg border border-green-600 px-3 py-1 text-xs font-semibold text-green-700 hover:bg-green-50"
        >
          แก้ไข
        </button>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-lg bg-gray-50 border border-gray-200 p-2">
          <p className="text-gray-500">ค่าแรง/วัน</p>
          <p className="font-semibold text-gray-800">
            {tech.dailyWage != null ? formatCurrency(tech.dailyWage) : "—"}
          </p>
        </div>
        <div className="rounded-lg bg-green-50 border border-green-200 p-2">
          <p className="text-green-700">เป้าค่างาน/วัน</p>
          <p className="font-semibold text-green-900">
            {target != null ? formatCurrency(target) : "—"}
          </p>
        </div>
        <div className="rounded-lg bg-gray-50 border border-gray-200 p-2">
          <p className="text-gray-500">โควตา/วัน</p>
          <p className="font-semibold text-gray-800">
            {tech.dailyCapacityItems != null
              ? `${tech.dailyCapacityItems} ชิ้น`
              : "—"}
          </p>
        </div>
      </div>

      {/* Skills */}
      <div className="mt-3 border-t border-gray-100 pt-3">
        <p className="text-xs font-semibold text-gray-700 mb-1">
          ทักษะ ({tech.skills.length})
        </p>
        {tech.skills.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {tech.skills.map((s) => (
              <span
                key={s.id}
                className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] text-green-800"
              >
                {s.preferred && <span title="ถนัด">★</span>}
                {s.serviceCode || s.categoryTh || "—"}
                <span className="text-green-600">· {s.skillLevel}</span>
                <button
                  onClick={() =>
                    void post({ action: "deleteSkill", skill: { id: s.id } })
                  }
                  disabled={busy}
                  className="text-red-500 hover:text-red-700"
                  aria-label="ลบทักษะ"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          <input
            value={skill.categoryTh}
            onChange={(e) => setSkill({ ...skill, categoryTh: e.target.value })}
            placeholder="หมวด"
            className="rounded-lg border border-gray-300 p-1.5 text-xs outline-none focus:ring-2 focus:ring-green-500"
          />
          <input
            value={skill.serviceCode}
            onChange={(e) =>
              setSkill({ ...skill, serviceCode: e.target.value })
            }
            placeholder="service_code"
            className="rounded-lg border border-gray-300 p-1.5 text-xs font-mono outline-none focus:ring-2 focus:ring-green-500"
          />
          <select
            value={skill.skillLevel}
            onChange={(e) =>
              setSkill({ ...skill, skillLevel: e.target.value })
            }
            className="rounded-lg border border-gray-300 p-1.5 text-xs outline-none focus:ring-2 focus:ring-green-500"
          >
            {SKILL_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              if (!skill.categoryTh.trim() && !skill.serviceCode.trim()) {
                onError("ระบุหมวด หรือ service_code");
                return;
              }
              void post({
                action: "addSkill",
                skill: { ...skill, technicianId: tech.id },
              }).then(() =>
                setSkill({
                  categoryTh: "",
                  subcategoryTh: "",
                  serviceCode: "",
                  skillLevel: "STANDARD",
                  preferred: false,
                })
              );
            }}
            disabled={busy}
            className="rounded-lg bg-green-700 px-2 py-1.5 text-xs font-semibold text-white hover:bg-green-800 disabled:opacity-50"
          >
            + ทักษะ
          </button>
        </div>
        <label className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-600">
          <input
            type="checkbox"
            checked={skill.preferred}
            onChange={(e) =>
              setSkill({ ...skill, preferred: e.target.checked })
            }
            className="h-3.5 w-3.5 accent-green-700"
          />
          ทำเครื่องหมายเป็นงานที่ถนัด (preferred)
        </label>
      </div>
    </div>
  );
}
