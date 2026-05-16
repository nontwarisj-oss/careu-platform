"use client";

// /portal/signin — phone + OTP sign-in.
// Phase 27A polish: session-expired banner (?expired=1), an OTP
// resend cooldown timer, and a "this device is remembered 30 days"
// reassurance line.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Step = "phone" | "code" | "done";

const RESEND_COOLDOWN_SECONDS = 60;

export default function PortalSignInPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Session-expired redirect lands here with ?expired=1.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("expired") === "1") setExpired(true);
  }, []);

  // Resend cooldown ticker.
  const startCooldown = useCallback(() => {
    setResendIn(RESEND_COOLDOWN_SECONDS);
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      setResendIn((s) => {
        if (s <= 1) {
          if (tickRef.current) clearInterval(tickRef.current);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }, []);
  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  const requestOtp = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/auth/request-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        requestId?: string;
        devCode?: string | null;
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `ไม่สำเร็จ (HTTP ${res.status})`);
        return false;
      }
      setRequestId(json.requestId ?? null);
      setDevCode(json.devCode ?? null);
      startCooldown();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      return false;
    } finally {
      setLoading(false);
    }
  }, [phone, startCooldown]);

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setExpired(false);
    const ok = await requestOtp();
    if (ok) setStep("code");
  };

  const handleResend = async () => {
    if (resendIn > 0) return;
    setCode("");
    await requestOtp();
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim(), code: code.trim() }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `ไม่สำเร็จ (HTTP ${res.status})`);
      } else {
        setStep("done");
        router.replace("/portal");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    }
    setLoading(false);
  };

  return (
    <div className="max-w-sm mx-auto">
      {expired && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          เซสชันหมดอายุ — กรุณาเข้าสู่ระบบอีกครั้ง
        </div>
      )}
      <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-extrabold text-gray-900">
          เข้าสู่ระบบลูกค้า
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          ใช้เบอร์โทรเดียวกับที่เคยใช้บริการที่ร้าน — รหัสจะส่งไปยังเบอร์นี้
          (ระยะ MVP ระบบจะแสดงรหัสในหน้านี้)
        </p>

        {error && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {step === "phone" && (
          <form onSubmit={handleRequest} className="mt-4 space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                เบอร์โทร
              </label>
              <input
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                placeholder="0812345678"
                className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !phone.trim()}
              className="w-full rounded-xl bg-green-700 hover:bg-green-800 text-white px-5 py-3 text-sm font-semibold disabled:opacity-50"
            >
              {loading ? "กำลังส่งรหัส..." : "ส่งรหัสยืนยัน"}
            </button>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={handleVerify} className="mt-4 space-y-3">
            <p className="text-xs text-gray-600">
              ส่งรหัสไปยัง {phone}
              {requestId && (
                <span className="block text-gray-400 mt-0.5 font-mono text-[10px]">
                  ref: {requestId.slice(0, 8)}
                </span>
              )}
            </p>
            {devCode && (
              <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-900">
                โหมดทดสอบ — ใช้รหัสนี้: <strong className="font-mono">{devCode}</strong>
                {" หรือใช้รหัสสากล "}
                <strong className="font-mono">123456</strong>
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                รหัส 6 หลัก
              </label>
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                required
                placeholder="000000"
                className="w-full rounded-xl border border-gray-200 px-3 py-3 text-2xl outline-none focus:ring-2 focus:ring-green-500 font-mono tracking-widest text-center"
              />
            </div>
            <button
              type="submit"
              disabled={loading || code.length !== 6}
              className="w-full rounded-xl bg-green-700 hover:bg-green-800 text-white px-5 py-3 text-sm font-semibold disabled:opacity-50"
            >
              {loading ? "กำลังตรวจสอบ..." : "ยืนยันรหัส"}
            </button>

            {/* Resend with cooldown */}
            <button
              type="button"
              onClick={() => void handleResend()}
              disabled={loading || resendIn > 0}
              className="w-full text-center text-xs font-semibold text-green-700 disabled:text-gray-400 disabled:font-normal"
            >
              {resendIn > 0
                ? `ขอรหัสใหม่ได้ใน ${resendIn} วินาที`
                : "ส่งรหัสอีกครั้ง"}
            </button>
            <button
              type="button"
              onClick={() => {
                setStep("phone");
                setCode("");
                setRequestId(null);
                setDevCode(null);
              }}
              className="w-full text-center text-xs text-gray-500 hover:text-gray-700"
            >
              เปลี่ยนเบอร์
            </button>
            <p className="text-center text-[10px] text-gray-400">
              อุปกรณ์นี้จะจดจำการเข้าสู่ระบบไว้ 30 วัน
            </p>
          </form>
        )}
      </div>

      <p className="mt-4 text-center text-xs text-gray-500">
        ยังไม่เคยใช้บริการ?{" "}
        <a href="/quote" className="text-green-700 font-semibold">
          ขอใบเสนอราคาก่อนได้
        </a>
      </p>
    </div>
  );
}
