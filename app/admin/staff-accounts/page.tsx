"use client";

// /admin/staff-accounts — internal staff login credential management.
//
// Create / edit the employee_code + password accounts used by /login.
// Owner / HQ Admin only (RouteGuard page="admin" + the API role gate).
// Distinct from /admin/staff, which manages LINE-login users + technician
// profiles in public.users / public.profiles.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { ROLE_DEFINITIONS, type Role } from "@/lib/roles";

type Account = {
  id: string;
  employee_code: string;
  full_name: string;
  role: string;
  branch_id: string | null;
  active: boolean;
  last_login_at: string | null;
  created_at: string;
};
type Branch = { code: string; name: string };

const ROLE_LIST: Role[] = [
  "owner",
  "hq_admin",
  "branch_manager",
  "front_staff",
  "technician",
];

const inputClass =
  "w-full rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500";

function roleLabel(role: string): string {
  return ROLE_DEFINITIONS[role as Role]?.labelTh ?? role;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function StaffAccountsPage() {
  return (
    <RouteGuard page="admin">
      <StaffAccountsInner />
    </RouteGuard>
  );
}

function StaffAccountsInner() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Create form
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<Role>("front_staff");
  const [newBranch, setNewBranch] = useState("");
  const [creating, setCreating] = useState(false);

  // Edit overlay
  const [editing, setEditing] = useState<Account | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState<Role>("front_staff");
  const [editBranch, setEditBranch] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editPassword, setEditPassword] = useState("");
  const [saving, setSaving] = useState(false);

  // Re-load used by the create / edit handlers (called post-await from an
  // event handler, never synchronously inside an effect).
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/staff/accounts", {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        accounts?: Account[];
        branches?: Branch[];
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `โหลดไม่สำเร็จ (HTTP ${res.status})`);
      } else {
        setAccounts(json.accounts ?? []);
        setBranches(json.branches ?? []);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
    }
    setLoading(false);
  }, []);

  // Initial load — inlined async IIFE so no setState runs synchronously in
  // the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/staff/accounts", {
          cache: "no-store",
        });
        const json = (await res.json()) as {
          ok?: boolean;
          reason?: string;
          accounts?: Account[];
          branches?: Branch[];
        };
        if (cancelled) return;
        if (!res.ok || !json.ok) {
          setError(json.reason ?? `โหลดไม่สำเร็จ (HTTP ${res.status})`);
        } else {
          setAccounts(json.accounts ?? []);
          setBranches(json.branches ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreate = async () => {
    setCreating(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/auth/staff/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          employeeCode: newCode,
          password: newPassword,
          fullName: newName,
          role: newRole,
          branchId: newBranch || null,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `สร้างบัญชีไม่สำเร็จ (HTTP ${res.status})`);
      } else {
        setMessage(`สร้างบัญชี "${newCode.trim().toLowerCase()}" เรียบร้อย`);
        setNewCode("");
        setNewName("");
        setNewPassword("");
        setNewRole("front_staff");
        setNewBranch("");
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "สร้างบัญชีไม่สำเร็จ");
    }
    setCreating(false);
  };

  const openEdit = (acc: Account) => {
    setEditing(acc);
    setEditName(acc.full_name);
    setEditRole((acc.role as Role) ?? "front_staff");
    setEditBranch(acc.branch_id ?? "");
    setEditActive(acc.active);
    setEditPassword("");
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/auth/staff/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          id: editing.id,
          fullName: editName,
          role: editRole,
          branchId: editBranch || null,
          active: editActive,
          password: editPassword || undefined,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `บันทึกไม่สำเร็จ (HTTP ${res.status})`);
      } else {
        setMessage(`บันทึกบัญชี "${editing.employee_code}" เรียบร้อย`);
        setEditing(null);
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ");
    }
    setSaving(false);
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            ศูนย์จัดการระบบ
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">บัญชีเข้าสู่ระบบพนักงาน</span>
        </div>

        <div className="border-l-4 border-yellow-400 pl-4">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS
          </p>
          <h1 className="text-3xl font-extrabold text-gray-900">
            บัญชีเข้าสู่ระบบพนักงาน
          </h1>
          <p className="text-sm text-gray-600">
            สร้างและจัดการบัญชีรหัสพนักงาน + รหัสผ่าน สำหรับเข้าสู่ระบบที่หน้า /login
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {message && (
          <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 flex items-start justify-between gap-3">
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

        {/* Create */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-bold text-gray-900 mb-3">
            เพิ่มบัญชีพนักงานใหม่
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                ชื่อ-นามสกุล
              </label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                รหัสพนักงาน (ใช้เข้าสู่ระบบ)
              </label>
              <input
                type="text"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)
              </label>
              <input
                type="text"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={inputClass}
                placeholder="ตั้งรหัสผ่านเริ่มต้นให้พนักงาน"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                บทบาท
              </label>
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as Role)}
                className={inputClass}
              >
                {ROLE_LIST.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_DEFINITIONS[r].labelTh}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                สาขา (เว้นว่างสำหรับ Owner / Admin ที่เห็นทุกสาขา)
              </label>
              <select
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                className={inputClass}
              >
                <option value="">— ไม่กำหนดสาขา —</option>
                {branches.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.code} • {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating}
            className="mt-4 rounded-xl bg-green-700 px-5 py-2.5 text-sm font-bold text-white hover:bg-green-800 disabled:opacity-50"
          >
            {creating ? "กำลังสร้าง..." : "สร้างบัญชี"}
          </button>
        </div>

        {/* List */}
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          {loading ? (
            <p className="p-8 text-center text-gray-500">กำลังโหลด...</p>
          ) : accounts.length === 0 ? (
            <p className="p-8 text-center text-gray-500">
              ยังไม่มีบัญชีพนักงานในระบบ
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="text-left p-3">รหัส / ชื่อ</th>
                    <th className="text-left p-3">บทบาท</th>
                    <th className="text-left p-3">สาขา</th>
                    <th className="text-left p-3">สถานะ</th>
                    <th className="text-left p-3">เข้าระบบล่าสุด</th>
                    <th className="text-right p-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((acc) => (
                    <tr
                      key={acc.id}
                      className="border-t border-gray-100 hover:bg-green-50/30"
                    >
                      <td className="p-3">
                        <p className="font-mono font-semibold text-gray-900">
                          {acc.employee_code}
                        </p>
                        <p className="text-[11px] text-gray-500">
                          {acc.full_name}
                        </p>
                      </td>
                      <td className="p-3">
                        <span className="inline-flex px-2 py-0.5 rounded-full border border-green-200 bg-green-50 text-green-800 text-[11px] font-semibold">
                          {roleLabel(acc.role)}
                        </span>
                      </td>
                      <td className="p-3 text-gray-700">
                        {acc.branch_id ?? (
                          <span className="text-gray-400">ทุกสาขา</span>
                        )}
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                            acc.active
                              ? "border-green-200 bg-green-50 text-green-800"
                              : "border-gray-200 bg-gray-100 text-gray-600"
                          }`}
                        >
                          {acc.active ? "เปิดใช้งาน" : "ปิดใช้งาน"}
                        </span>
                      </td>
                      <td className="p-3 text-[11px] text-gray-500">
                        {formatDate(acc.last_login_at)}
                      </td>
                      <td className="p-3 text-right">
                        <button
                          type="button"
                          onClick={() => openEdit(acc)}
                          className="text-sm font-medium text-green-700 hover:text-green-800"
                        >
                          จัดการ →
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

      {/* Edit overlay */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="text-lg font-bold text-gray-900">
                  จัดการบัญชี
                </h2>
                <p className="font-mono text-sm text-gray-500">
                  {editing.employee_code}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="text-gray-400 hover:text-gray-700"
                aria-label="close"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  ชื่อ-นามสกุล
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  บทบาท
                </label>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as Role)}
                  className={inputClass}
                >
                  {ROLE_LIST.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_DEFINITIONS[r].labelTh}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  สาขา
                </label>
                <select
                  value={editBranch}
                  onChange={(e) => setEditBranch(e.target.value)}
                  className={inputClass}
                >
                  <option value="">— ไม่กำหนดสาขา —</option>
                  {branches.map((b) => (
                    <option key={b.code} value={b.code}>
                      {b.code} • {b.name}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={editActive}
                  onChange={(e) => setEditActive(e.target.checked)}
                  className="w-4 h-4 accent-green-700"
                />
                เปิดใช้งานบัญชีนี้
              </label>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  รีเซ็ตรหัสผ่าน (เว้นว่างหากไม่เปลี่ยน)
                </label>
                <input
                  type="text"
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  className={inputClass}
                  placeholder="รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => void handleSaveEdit()}
                disabled={saving}
                className="rounded-xl bg-green-700 px-5 py-2 text-sm font-bold text-white hover:bg-green-800 disabled:opacity-50"
              >
                {saving ? "กำลังบันทึก..." : "บันทึก"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
