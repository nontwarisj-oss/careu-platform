"use client";

// /login — internal staff sign-in (employee_code + password).
//
// On success the server returns a staff session object; the browser stores it
// in localStorage (lib/simpleStaffSession.ts). No SESSION_SECRET, no signed
// cookie. While public.staff_accounts is empty the page shows a one-time owner
// setup form. LINE Login is kept as an optional button when LINE is configured.

import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BrandLogo } from "@/components/BrandLogo";
import { PasswordInput } from "@/components/PasswordInput";
import { useAuth } from "@/lib/authContext";
import { useLanguage } from "@/lib/languageContext";
import {
  setSimpleStaffSession,
  type SimpleStaffSession,
} from "@/lib/simpleStaffSession";

const ERROR_MESSAGES_TH: Record<string, string> = {
  line_not_configured: "LINE Login ยังไม่ตั้งค่า",
  session_secret_missing: "SESSION_SECRET ยังไม่ถูกตั้งใน environment",
  missing_code_or_state: "LINE ส่งกลับมาไม่ครบ — ลองล็อกอินใหม่อีกครั้ง",
  state_mismatch: "ตรวจสอบ state ไม่ผ่าน — ลองใหม่อีกครั้ง (อาจมีการแอบเข้าระบบ)",
  oauth_exchange_failed: "แลกโทเค็นกับ LINE ไม่สำเร็จ — ตรวจ Channel ID / Secret",
  users_table_unreachable: "อ่านตาราง users ไม่ได้ — ยังไม่ได้รัน migration ใช่หรือไม่?",
  users_insert_failed: "สร้างผู้ใช้ใหม่ไม่สำเร็จ",
  account_disabled: "บัญชีนี้ถูกปิดใช้งาน ติดต่อผู้ดูแลระบบ",
  session_encode_failed: "เซ็น session ไม่สำเร็จ",
};

const inputClass =
  "w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500";

function LoginInner() {
  const { language } = useLanguage();
  const { lineConfigured, isLoading, user } = useAuth();
  const params = useSearchParams();
  const errorCode = params.get("error");
  const after = params.get("after") ?? "/";
  const th = language === "th";

  // null = still checking; true = staff_accounts empty → show setup form.
  const [bootstrapNeeded, setBootstrapNeeded] = useState<boolean | null>(null);

  const [employeeCode, setEmployeeCode] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState(""); // bootstrap only
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/staff/bootstrap", {
          cache: "no-store",
        });
        const json = (await res.json()) as { needed?: boolean };
        if (!cancelled) setBootstrapNeeded(json.needed === true);
      } catch {
        if (!cancelled) setBootstrapNeeded(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startUrl = `/api/auth/line/start${
    after !== "/" ? `?after=${encodeURIComponent(after)}` : ""
  }`;

  const post = useCallback(
    async (url: string, payload: Record<string, string>) => {
      if (busy) return;
      setBusy(true);
      setFormError(null);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          reason?: string;
          session?: SimpleStaffSession;
        };
        if (!res.ok || !json.ok || !json.session) {
          setFormError(
            json.reason ?? `ดำเนินการไม่สำเร็จ (HTTP ${res.status})`
          );
          setBusy(false);
          return;
        }
        // Persist the staff session, then full-reload so AuthProvider picks
        // it up from localStorage.
        setSimpleStaffSession(json.session);
        window.location.assign(after);
      } catch (err) {
        setFormError(
          err instanceof Error ? err.message : "เครือข่ายขัดข้อง"
        );
        setBusy(false);
      }
    },
    [busy, after]
  );

  const submitLogin = (e: FormEvent) => {
    e.preventDefault();
    void post("/api/auth/staff/login", { employeeCode, password });
  };
  const submitBootstrap = (e: FormEvent) => {
    e.preventDefault();
    void post("/api/auth/staff/bootstrap", {
      employeeCode,
      password,
      fullName,
    });
  };

  const showBootstrap = bootstrapNeeded === true;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 via-white to-yellow-50 p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-md border border-green-100 p-8">
        <div className="flex items-center gap-3 mb-6">
          <BrandLogo size="lg" variant="onLight" />
          <div>
            <p className="text-[10px] uppercase tracking-[0.22em] text-green-700 font-bold">
              CareU OPS
            </p>
            <h1 className="text-2xl font-extrabold text-gray-900 leading-tight">
              {showBootstrap
                ? th
                  ? "ตั้งค่าบัญชีเจ้าของ"
                  : "Set up owner account"
                : th
                ? "เข้าสู่ระบบ"
                : "Sign in"}
            </h1>
          </div>
        </div>

        {errorCode && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {ERROR_MESSAGES_TH[errorCode] ?? `เกิดข้อผิดพลาด: ${errorCode}`}
          </div>
        )}

        {user && (
          <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            {th
              ? `เข้าสู่ระบบในชื่อ ${user.name} อยู่แล้ว`
              : `Already signed in as ${user.name}`}
            <Link href="/" className="ml-2 underline font-medium">
              {th ? "ไปแดชบอร์ด" : "Go to dashboard"}
            </Link>
          </div>
        )}

        {formError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {formError}
          </div>
        )}

        {bootstrapNeeded === null ? (
          <p className="text-sm text-gray-500 text-center py-4">
            {th ? "กำลังตรวจสอบระบบ..." : "Checking system..."}
          </p>
        ) : showBootstrap ? (
          <form onSubmit={submitBootstrap} className="space-y-3">
            <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              {th
                ? "ยังไม่มีบัญชีพนักงานในระบบ — สร้างบัญชีเจ้าของกิจการ (Owner) บัญชีแรก แบบฟอร์มนี้จะใช้ได้ครั้งเดียว"
                : "No staff accounts yet — create the first Owner account. This form works only once."}
            </p>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                {th ? "ชื่อ-นามสกุล" : "Full name"}
              </label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className={inputClass}
                autoComplete="name"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                {th ? "รหัสพนักงาน" : "Employee code"}
              </label>
              <input
                type="text"
                value={employeeCode}
                onChange={(e) => setEmployeeCode(e.target.value)}
                className={inputClass}
                autoComplete="username"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                {th ? "รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)" : "Password (≥8 chars)"}
              </label>
              <PasswordInput
                value={password}
                onChange={setPassword}
                className={inputClass}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-green-700 hover:bg-green-800 text-white font-semibold py-3 disabled:opacity-50"
            >
              {busy
                ? th
                  ? "กำลังสร้างบัญชี..."
                  : "Creating..."
                : th
                ? "สร้างบัญชีเจ้าของ และเข้าสู่ระบบ"
                : "Create owner & sign in"}
            </button>
          </form>
        ) : (
          <form onSubmit={submitLogin} className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                {th ? "รหัสพนักงาน" : "Employee code"}
              </label>
              <input
                type="text"
                value={employeeCode}
                onChange={(e) => setEmployeeCode(e.target.value)}
                className={inputClass}
                autoComplete="username"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                {th ? "รหัสผ่าน" : "Password"}
              </label>
              <PasswordInput
                value={password}
                onChange={setPassword}
                className={inputClass}
                autoComplete="current-password"
                required
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-green-700 hover:bg-green-800 text-white font-semibold py-3 disabled:opacity-50"
            >
              {busy
                ? th
                  ? "กำลังเข้าสู่ระบบ..."
                  : "Signing in..."
                : th
                ? "เข้าสู่ระบบ"
                : "Sign in"}
            </button>
          </form>
        )}

        {lineConfigured && !showBootstrap && (
          <>
            <div className="my-4 flex items-center gap-3 text-[11px] text-gray-400">
              <span className="h-px flex-1 bg-gray-200" />
              {th ? "หรือ" : "or"}
              <span className="h-px flex-1 bg-gray-200" />
            </div>
            <a
              href={startUrl}
              className="block w-full text-center bg-[#06C755] hover:bg-[#05b94d] text-white font-semibold py-3 rounded-xl"
            >
              {th ? "เข้าสู่ระบบด้วย LINE" : "Sign in with LINE"}
            </a>
          </>
        )}

        <p className="mt-6 text-[11px] text-gray-500 text-center">
          {isLoading
            ? th
              ? "กำลังตรวจสอบสถานะการล็อกอิน..."
              : "Checking auth state..."
            : th
            ? "หากเข้าสู่ระบบไม่ได้ ติดต่อผู้ดูแลระบบ"
            : "Trouble signing in? Contact your administrator."}
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="p-8 text-center text-gray-500">Loading...</div>
      }
    >
      <LoginInner />
    </Suspense>
  );
}
