"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BrandLogo } from "@/components/BrandLogo";
import { useAuth } from "@/lib/authContext";
import { useLanguage } from "@/lib/languageContext";

const ERROR_MESSAGES_TH: Record<string, string> = {
  line_not_configured:
    "LINE Login ยังไม่ตั้งค่า — ตั้งค่า LINE_LOGIN_CHANNEL_ID / SECRET / CALLBACK_URL ใน environment",
  session_secret_missing: "SESSION_SECRET ยังไม่ถูกตั้งใน environment",
  missing_code_or_state: "LINE ส่งกลับมาไม่ครบ — ลองล็อกอินใหม่อีกครั้ง",
  state_mismatch: "ตรวจสอบ state ไม่ผ่าน — ลองใหม่อีกครั้ง (อาจมีการแอบเข้าระบบ)",
  oauth_exchange_failed: "แลกโทเค็นกับ LINE ไม่สำเร็จ — ตรวจ Channel ID / Secret",
  users_table_unreachable: "อ่านตาราง users ไม่ได้ — ยังไม่ได้รัน migration ใช่หรือไม่?",
  users_insert_failed: "สร้างผู้ใช้ใหม่ไม่สำเร็จ",
  account_disabled: "บัญชีนี้ถูกปิดใช้งาน ติดต่อผู้ดูแลระบบ",
  session_encode_failed: "เซ็น session ไม่สำเร็จ — SESSION_SECRET อาจสั้นเกินไป",
};

function LoginInner() {
  const { language } = useLanguage();
  const { lineConfigured, sessionConfigured, isLoading, user } = useAuth();
  const params = useSearchParams();
  const errorCode = params.get("error");
  const after = params.get("after") ?? "/";

  const startUrl = `/api/auth/line/start${
    after !== "/" ? `?after=${encodeURIComponent(after)}` : ""
  }`;

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
              {language === "th" ? "เข้าสู่ระบบ" : "Sign in"}
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
            {language === "th"
              ? `เข้าสู่ระบบในชื่อ ${user.name} อยู่แล้ว`
              : `Already signed in as ${user.name}`}
            <Link href="/" className="ml-2 underline font-medium">
              {language === "th" ? "ไปแดชบอร์ด" : "Go to dashboard"}
            </Link>
          </div>
        )}

        {!lineConfigured ? (
          <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-900">
            <p className="font-semibold mb-1">
              {language === "th"
                ? "ระบบยังไม่ได้ตั้งค่า LINE Login"
                : "LINE Login is not configured yet"}
            </p>
            <p className="text-yellow-800 text-[12px] leading-relaxed">
              {language === "th"
                ? "ตั้งค่า LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET / LINE_LOGIN_CALLBACK_URL ใน environment แล้ว redeploy — ระบบจะเปิดใช้งานล็อกอินอัตโนมัติ"
                : "Set LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET / LINE_LOGIN_CALLBACK_URL and redeploy."}
              <br />
              <span className="block mt-2 font-mono text-[11px] text-yellow-700">
                session_configured: {String(sessionConfigured)} •
                line_configured: {String(lineConfigured)}
              </span>
            </p>
          </div>
        ) : (
          <a
            href={startUrl}
            className="block w-full text-center bg-[#06C755] hover:bg-[#05b94d] text-white font-semibold py-3 rounded-xl"
          >
            {language === "th" ? "เข้าสู่ระบบด้วย LINE" : "Sign in with LINE"}
          </a>
        )}

        <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
          {language === "th"
            ? "เร็วๆ นี้: ล็อกอินด้วยเบอร์โทร (OTP) สำหรับผู้ใช้ที่ไม่มี LINE"
            : "Coming soon: phone OTP login for users without LINE."}
        </div>

        <p className="mt-6 text-[11px] text-gray-500 text-center">
          {isLoading
            ? language === "th"
              ? "กำลังตรวจสอบสถานะการล็อกอิน..."
              : "Checking auth state..."
            : language === "th"
            ? "หากเข้าสู่ระบบไม่ได้ ติดต่อผู้ดูแลระบบ"
            : "Trouble signing in? Contact your administrator."}
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-500">Loading...</div>}>
      <LoginInner />
    </Suspense>
  );
}
