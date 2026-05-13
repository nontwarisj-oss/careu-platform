"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { Modal } from "@/components/Modal";
import { useLanguage } from "@/lib/languageContext";
import { useRole } from "@/lib/roleContext";
import { canManageStaff } from "@/lib/permissions";
import { ROLE_DEFINITIONS, type Role } from "@/lib/roles";
import { SKILL_CATALOG, type Skill } from "@/lib/technicianService";
import {
  fetchBranchOptions,
  fetchStaffList,
  setTechnicianActive,
  updateProfileRole,
  upsertTechnicianProfile,
  type BranchOption,
  type StaffRow,
} from "@/lib/staffService";

type RoleFilter = "all" | Role;
type ActiveFilter = "active" | "inactive" | "all";

type EditState = {
  staff: StaffRow;
  /** Profile fields */
  role: Role;
  branchId: string;
  isActive: boolean;
  /** Technician fields */
  techDisplayName: string;
  techActive: boolean;
  techSkills: Skill[];
  techDailyWage: string;
  techMultiplier: string;
  techProductivityTarget: string;
};

const ROLE_LIST: Role[] = [
  "owner",
  "hq_admin",
  "branch_manager",
  "front_staff",
  "technician",
];

export default function AdminStaffPage() {
  return (
    <RouteGuard page="admin">
      <AdminStaffInner />
    </RouteGuard>
  );
}

function AdminStaffInner() {
  const { language } = useLanguage();
  const { role } = useRole();
  const canEdit = canManageStaff(role);

  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [branchFilter, setBranchFilter] = useState<string>("all");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("active");

  const [editing, setEditing] = useState<EditState | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const [list, opts] = await Promise.all([
      fetchStaffList(),
      fetchBranchOptions(),
    ]);
    setStaff(list.rows);
    setBranches(opts);
    if (list.error) setError(list.error);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return staff.filter((row) => {
      if (roleFilter !== "all" && row.role !== roleFilter) return false;
      if (branchFilter !== "all" && row.branchId !== branchFilter) return false;
      if (activeFilter === "active" && !row.isActive) return false;
      if (activeFilter === "inactive" && row.isActive) return false;
      if (q) {
        const hay = [
          row.fullName,
          row.phone ?? "",
          row.lineUserId ?? "",
          row.branchName ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [staff, search, roleFilter, branchFilter, activeFilter]);

  const summary = useMemo(() => {
    const active = staff.filter((s) => s.isActive);
    const technicians = active.filter((s) => s.role === "technician");
    const techsWithProfile = technicians.filter((s) => s.technician).length;
    const techsWithoutProfile = technicians.length - techsWithProfile;
    return {
      total: staff.length,
      active: active.length,
      technicians: technicians.length,
      techsWithoutProfile,
    };
  }, [staff]);

  const openEdit = (s: StaffRow) => {
    if (!canEdit) return;
    setEditing({
      staff: s,
      role: s.role,
      branchId: s.branchId ?? "",
      isActive: s.isActive,
      techDisplayName: s.technician?.displayName ?? s.fullName,
      techActive: s.technician?.active ?? true,
      techSkills: (s.technician?.skillTags ?? []) as Skill[],
      techDailyWage:
        s.technician?.dailyWage != null ? String(s.technician.dailyWage) : "",
      techMultiplier: String(s.technician?.targetMultiplier ?? 3),
      techProductivityTarget:
        s.technician?.productivityTarget != null
          ? String(s.technician.productivityTarget)
          : "",
    });
  };

  const handleSave = async () => {
    if (!editing) return;
    setIsSaving(true);
    setMessage(null);

    const profileRes = await updateProfileRole(editing.staff.id, {
      role: editing.role,
      branchId: editing.branchId || null,
      isActive: editing.isActive,
    });
    if (profileRes.error) {
      setMessage(`${language === "th" ? "บันทึกโปรไฟล์ไม่สำเร็จ" : "Profile save failed"}: ${profileRes.error}`);
      setIsSaving(false);
      return;
    }

    // If the role is technician we maintain a technician_profiles row.
    if (editing.role === "technician") {
      const techRes = await upsertTechnicianProfile(
        editing.staff.id,
        editing.staff.technician?.id ?? null,
        {
          displayName: editing.techDisplayName.trim() || editing.staff.fullName,
          active: editing.techActive,
          skillTags: editing.techSkills,
          dailyWage:
            editing.techDailyWage.trim() === ""
              ? null
              : Number(editing.techDailyWage),
          targetMultiplier: Number(editing.techMultiplier || 3),
          productivityTarget:
            editing.techProductivityTarget.trim() === ""
              ? null
              : Number(editing.techProductivityTarget),
          branchId: editing.branchId || null,
        }
      );
      if (techRes.error) {
        setMessage(`${language === "th" ? "บันทึกข้อมูลช่างไม่สำเร็จ" : "Technician save failed"}: ${techRes.error}`);
        setIsSaving(false);
        return;
      }
    }

    setMessage(language === "th" ? "บันทึกเรียบร้อย" : "Saved");
    setEditing(null);
    await load();
    setIsSaving(false);
  };

  const handleQuickToggleTech = async (row: StaffRow) => {
    if (!canEdit || !row.technician) return;
    const next = !row.technician.active;
    const res = await setTechnicianActive(row.technician.id, next);
    if (res.error) {
      setMessage(res.error);
      return;
    }
    setMessage(
      language === "th"
        ? next
          ? `เปิดใช้งานช่าง "${row.technician.displayName}"`
          : `ปิดใช้งานช่าง "${row.technician.displayName}"`
        : next
        ? `Activated technician "${row.technician.displayName}"`
        : `Deactivated technician "${row.technician.displayName}"`
    );
    await load();
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-4 flex items-center gap-2 text-xs text-gray-500">
        <Link href="/admin" className="hover:text-green-700">
          {language === "th" ? "ศูนย์จัดการระบบ" : "Admin centre"}
        </Link>
        <span>/</span>
        <span className="text-gray-700 font-medium">
          {language === "th" ? "พนักงาน" : "Staff"}
        </span>
      </div>

      <div className="mb-5 flex flex-col gap-2 border-l-4 border-yellow-400 pl-4">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
          CareU OPS
        </p>
        <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
          {language === "th" ? "จัดการพนักงาน" : "Manage staff"}
        </h1>
        <p className="text-sm text-gray-600">
          {language === "th"
            ? "เปลี่ยนบทบาท ย้ายสาขา เปิด/ปิดการใช้งาน และตั้งค่าโปรไฟล์ช่างซ่อม"
            : "Change roles, move branches, activate/deactivate, configure technician profiles."}
        </p>
        {!canEdit && (
          <span className="mt-1 inline-block px-2 py-0.5 rounded-full bg-yellow-50 border border-yellow-200 text-yellow-800 text-[11px] font-semibold">
            {language === "th"
              ? "โหมดดูเท่านั้น — เฉพาะ Owner / HQ Admin แก้ไขได้"
              : "Read-only — Owner / HQ Admin only"}
          </span>
        )}
      </div>

      {/* Summary chips */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">
            {language === "th" ? "พนักงานทั้งหมด" : "All staff"}
          </p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{summary.total}</p>
        </div>
        <div className="rounded-2xl border border-green-100 bg-green-50 p-4 shadow-sm">
          <p className="text-xs text-green-800">
            {language === "th" ? "เปิดใช้งาน" : "Active"}
          </p>
          <p className="mt-1 text-2xl font-bold text-green-900">
            {summary.active}
          </p>
        </div>
        <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4 shadow-sm">
          <p className="text-xs text-blue-800">
            {language === "th" ? "ช่างซ่อม" : "Technicians"}
          </p>
          <p className="mt-1 text-2xl font-bold text-blue-900">
            {summary.technicians}
          </p>
        </div>
        <div className="rounded-2xl border border-yellow-100 bg-yellow-50 p-4 shadow-sm">
          <p className="text-xs text-yellow-800">
            {language === "th"
              ? "ช่างที่ยังไม่ตั้งโปรไฟล์"
              : "Technicians without profile"}
          </p>
          <p className="mt-1 text-2xl font-bold text-yellow-900">
            {summary.techsWithoutProfile}
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {message && (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 flex items-start justify-between gap-3">
          <span>{message}</span>
          <button
            onClick={() => setMessage(null)}
            className="text-green-700 hover:text-green-900"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="grid gap-2 sm:grid-cols-4 mb-4">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            language === "th" ? "ค้นหาชื่อ / โทร / สาขา" : "Search name / phone / branch"
          }
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500 sm:col-span-2"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="all">
            {language === "th" ? "ทุกบทบาท" : "All roles"}
          </option>
          {ROLE_LIST.map((r) => (
            <option key={r} value={r}>
              {language === "th"
                ? ROLE_DEFINITIONS[r].labelTh
                : ROLE_DEFINITIONS[r].labelEn}
            </option>
          ))}
        </select>
        <select
          value={branchFilter}
          onChange={(e) => setBranchFilter(e.target.value)}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="all">
            {language === "th" ? "ทุกสาขา" : "All branches"}
          </option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.shortCode ? `${b.shortCode} • ` : ""}
              {b.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-4 flex gap-1 text-xs">
        {(["active", "inactive", "all"] as ActiveFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setActiveFilter(f)}
            className={`px-3 py-1.5 rounded-full border font-medium transition ${
              activeFilter === f
                ? "bg-green-700 border-green-700 text-white"
                : "bg-white border-gray-200 text-gray-700 hover:bg-green-50"
            }`}
          >
            {f === "active"
              ? language === "th"
                ? "เปิดใช้งาน"
                : "Active"
              : f === "inactive"
              ? language === "th"
                ? "ปิดใช้งาน"
                : "Inactive"
              : language === "th"
              ? "ทั้งหมด"
              : "All"}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">
            {language === "th" ? "กำลังโหลด..." : "Loading..."}
          </div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {staff.length === 0
              ? language === "th"
                ? "ยังไม่มีพนักงานในระบบ — ผู้ใช้คนแรกที่เข้าระบบจะถูกตั้งเป็น Owner อัตโนมัติ"
                : "No staff yet — the first LINE-login user is bootstrapped as Owner"
              : language === "th"
              ? "ไม่พบรายการตามตัวกรอง"
              : "No matches"}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="text-left p-3">
                    {language === "th" ? "ชื่อ" : "Name"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "บทบาท" : "Role"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "สาขา" : "Branch"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "ช่างซ่อม" : "Technician"}
                  </th>
                  <th className="text-left p-3">
                    {language === "th" ? "สถานะ" : "Status"}
                  </th>
                  <th className="text-right p-3"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const def = ROLE_DEFINITIONS[row.role];
                  return (
                    <tr
                      key={row.id}
                      className="border-t border-gray-100 hover:bg-green-50/30"
                    >
                      <td className="p-3">
                        <p className="font-semibold text-gray-900">
                          {row.fullName}
                        </p>
                        <p className="text-[11px] text-gray-500">
                          {row.phone ?? row.lineUserId ?? "—"}
                        </p>
                      </td>
                      <td className="p-3">
                        <span className="inline-flex px-2 py-0.5 rounded-full border border-green-200 bg-green-50 text-green-800 text-[11px] font-semibold">
                          {language === "th" ? def.labelTh : def.labelEn}
                        </span>
                      </td>
                      <td className="p-3 text-gray-700">
                        {row.branchName ?? (
                          <span className="text-gray-400">
                            {language === "th" ? "— ยังไม่กำหนด" : "— unassigned"}
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        {row.technician ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="text-gray-800">
                              {row.technician.displayName}
                            </span>
                            <span className="text-[10px] text-gray-500">
                              {row.technician.skillTags.length} skill •{" "}
                              {row.technician.dailyWage != null
                                ? `${row.technician.dailyWage}฿/วัน`
                                : language === "th"
                                ? "ยังไม่ตั้งค่าแรง"
                                : "no wage"}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleQuickToggleTech(row)}
                              disabled={!canEdit}
                              className={`mt-1 self-start px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                                row.technician.active
                                  ? "border-green-200 bg-green-50 text-green-800 hover:bg-green-100"
                                  : "border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100"
                              } disabled:opacity-60`}
                            >
                              {row.technician.active
                                ? language === "th"
                                  ? "เปิดใช้งาน"
                                  : "Active"
                                : language === "th"
                                ? "ปิดใช้งาน"
                                : "Inactive"}
                            </button>
                          </div>
                        ) : row.role === "technician" ? (
                          <span className="text-yellow-700 text-[11px]">
                            {language === "th" ? "ยังไม่ตั้งโปรไฟล์" : "no profile yet"}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                            row.isActive
                              ? "border-green-200 bg-green-50 text-green-800"
                              : "border-gray-200 bg-gray-100 text-gray-600"
                          }`}
                        >
                          {row.isActive
                            ? language === "th"
                              ? "เปิดใช้งาน"
                              : "Active"
                            : language === "th"
                            ? "ปิดใช้งาน"
                            : "Inactive"}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <button
                          type="button"
                          onClick={() => openEdit(row)}
                          disabled={!canEdit}
                          className="text-sm font-medium text-green-700 hover:text-green-800 disabled:opacity-50"
                        >
                          {language === "th" ? "จัดการ →" : "Manage →"}
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

      {editing && (
        <Modal
          isOpen={!!editing}
          onClose={() => setEditing(null)}
          size="lg"
          hideFooter
          title={
            language === "th"
              ? `จัดการ ${editing.staff.fullName}`
              : `Manage ${editing.staff.fullName}`
          }
        >
          <div className="space-y-4 text-sm">
            <fieldset className="rounded-xl border border-gray-200 p-3 space-y-3">
              <legend className="px-1 text-[11px] uppercase tracking-widest text-gray-500">
                {language === "th" ? "บัญชีผู้ใช้" : "User account"}
              </legend>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  {language === "th" ? "บทบาท" : "Role"}
                </label>
                <select
                  value={editing.role}
                  onChange={(e) =>
                    setEditing({ ...editing, role: e.target.value as Role })
                  }
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-green-500"
                >
                  {ROLE_LIST.map((r) => (
                    <option key={r} value={r}>
                      {language === "th"
                        ? ROLE_DEFINITIONS[r].labelTh
                        : ROLE_DEFINITIONS[r].labelEn}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  {language === "th" ? "สาขา" : "Branch"}
                </label>
                <select
                  value={editing.branchId}
                  onChange={(e) =>
                    setEditing({ ...editing, branchId: e.target.value })
                  }
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="">
                    {language === "th" ? "— ไม่กำหนดสาขา" : "— unassigned"}
                  </option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.shortCode ? `${b.shortCode} • ` : ""}
                      {b.name}
                    </option>
                  ))}
                </select>
                {(editing.role === "branch_manager" ||
                  editing.role === "front_staff" ||
                  editing.role === "technician") &&
                  !editing.branchId && (
                    <p className="mt-1 text-[11px] text-yellow-700">
                      {language === "th"
                        ? "บทบาทนี้ควรผูกกับสาขา — ผู้ใช้จะเห็นข้อมูลว่างเปล่าหากไม่กำหนด"
                        : "This role should be tied to a branch — the user will see no data otherwise."}
                    </p>
                  )}
              </div>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={editing.isActive}
                  onChange={(e) =>
                    setEditing({ ...editing, isActive: e.target.checked })
                  }
                  className="w-4 h-4 accent-green-700"
                />
                <span className="text-gray-700">
                  {language === "th"
                    ? "เปิดใช้งานบัญชีนี้"
                    : "Account active"}
                </span>
              </label>
            </fieldset>

            {editing.role === "technician" && (
              <fieldset className="rounded-xl border border-blue-200 p-3 space-y-3">
                <legend className="px-1 text-[11px] uppercase tracking-widest text-blue-700">
                  {language === "th"
                    ? "โปรไฟล์ช่างซ่อม"
                    : "Technician profile"}
                </legend>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    {language === "th"
                      ? "ชื่อที่ใช้แสดงในระบบมอบหมายงาน"
                      : "Display name (assignment dropdown)"}
                  </label>
                  <input
                    type="text"
                    value={editing.techDisplayName}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        techDisplayName: e.target.value,
                      })
                    }
                    className="w-full rounded-xl border border-gray-200 px-3 py-2 outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={editing.techActive}
                    onChange={(e) =>
                      setEditing({ ...editing, techActive: e.target.checked })
                    }
                    className="w-4 h-4 accent-green-700"
                  />
                  <span className="text-gray-700">
                    {language === "th"
                      ? "พร้อมรับมอบหมายงาน"
                      : "Available for assignment"}
                  </span>
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">
                      {language === "th" ? "ค่าแรง/วัน (฿)" : "Daily wage (฿)"}
                    </label>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="1"
                      value={editing.techDailyWage}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          techDailyWage: e.target.value,
                        })
                      }
                      className="w-full rounded-xl border border-gray-200 px-3 py-2 outline-none focus:ring-2 focus:ring-green-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">
                      {language === "th" ? "ตัวคูณเป้า" : "Target multiplier"}
                    </label>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.1"
                      value={editing.techMultiplier}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          techMultiplier: e.target.value,
                        })
                      }
                      className="w-full rounded-xl border border-gray-200 px-3 py-2 outline-none focus:ring-2 focus:ring-green-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    {language === "th"
                      ? "เป้าผลิตต่อวัน (override) — เว้นว่างเพื่อใช้ ค่าแรง × ตัวคูณ"
                      : "Productivity target override (blank = wage × multiplier)"}
                  </label>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="1"
                    value={editing.techProductivityTarget}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        techProductivityTarget: e.target.value,
                      })
                    }
                    className="w-full rounded-xl border border-gray-200 px-3 py-2 outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    {language === "th" ? "ทักษะ" : "Skills"}
                  </label>
                  <div className="grid grid-cols-2 gap-1">
                    {SKILL_CATALOG.map((skill) => {
                      const checked = editing.techSkills.includes(skill.code);
                      return (
                        <label
                          key={skill.code}
                          className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 cursor-pointer text-xs ${
                            checked
                              ? "border-green-300 bg-green-50"
                              : "border-gray-200 bg-white"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setEditing((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      techSkills: checked
                                        ? prev.techSkills.filter(
                                            (s) => s !== skill.code
                                          )
                                        : [...prev.techSkills, skill.code],
                                    }
                                  : prev
                              )
                            }
                            className="w-3.5 h-3.5 accent-green-700"
                          />
                          <span>
                            {language === "th" ? skill.labelTh : skill.labelEn}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </fieldset>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="px-4 py-2 rounded-xl border border-gray-200 bg-white text-sm hover:bg-gray-50"
              >
                {language === "th" ? "ยกเลิก" : "Cancel"}
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={isSaving}
                className="px-4 py-2 rounded-xl bg-green-700 hover:bg-green-800 text-white font-semibold text-sm disabled:opacity-60"
              >
                {isSaving
                  ? language === "th"
                    ? "กำลังบันทึก..."
                    : "Saving..."
                  : language === "th"
                  ? "บันทึก"
                  : "Save"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
