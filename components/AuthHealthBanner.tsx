"use client";

import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/authContext";

/**
 * Surfaces silent auth/RLS misconfiguration so operators don't stare at empty
 * dashboards without knowing why. Three failure modes the banner covers:
 *
 *   1. Strict mode + JWT bridge not configured. The bridge JWT comes back
 *      null, the supabase anon client runs as `anon`, and every RLS-protected
 *      read (orders, customers, …) returns 0 rows. Without this banner the
 *      symptom looks identical to "no data exists".
 *   2. Strict mode + signed-out (handled elsewhere by the /login redirect, so
 *      we just stay silent here while the auth provider resolves).
 *
 * Hidden on /login so the login card stays clean.
 */
export function AuthHealthBanner() {
  const pathname = usePathname();
  const { authRequired, jwtBridgeConfigured, isAuthenticated, isLoading } =
    useAuth();

  if (pathname === "/login") return null;
  if (isLoading) return null;
  if (!authRequired) return null; // preview mode — no JWT bridge needed
  if (!isAuthenticated) return null; // login redirect handles this
  if (jwtBridgeConfigured) return null;

  return (
    <div className="bg-red-600 text-white text-xs md:text-sm px-4 py-2 print:hidden">
      <strong className="font-semibold">RLS bridge ไม่ได้ตั้งค่า</strong>
      {" — "}
      <code className="bg-black/20 px-1 rounded">SUPABASE_JWT_SECRET</code>
      {" "}
      ยังไม่ถูกตั้งใน environment. ตารางที่เปิด RLS (orders / customers / expenses)
      จะคืนค่าว่างทุก query แม้ผู้ใช้จะ login แล้ว — แจ้งผู้ดูแลระบบให้ตั้งค่าตัวแปร
      และ redeploy ก่อนใช้งานจริง.
    </div>
  );
}
