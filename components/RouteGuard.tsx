"use client";

import { ReactNode } from "react";
import Link from "next/link";
import { useRole } from "@/lib/roleContext";
import { useAuth } from "@/lib/authContext";
import { canAccessPage, type PageKey } from "@/lib/roles";

interface RouteGuardProps {
  page: PageKey;
  children: ReactNode;
  /** When true, hide the "ไม่มีสิทธิ์" panel entirely and just render nothing. */
  silent?: boolean;
}

/**
 * Client-side visibility gate for role-restricted pages. Pairs with the
 * sidebar's nav filter so users that type the URL directly still hit a clear
 * "ไม่มีสิทธิ์" panel instead of seeing financial data they shouldn't.
 *
 * This is NOT real auth — the route still loads. Once Supabase Auth + RLS
 * are wired, server policies become the real enforcement; this guard then
 * acts as a UX polish for "you're signed in but your role doesn't include
 * this view".
 */
export function RouteGuard({ page, children, silent }: RouteGuardProps) {
  const { role, definition } = useRole();
  const { authRequired, user, isLoading } = useAuth();

  // While AuthProvider is still resolving /me, render a neutral skeleton so
  // the role-restricted page doesn't flash for unauthorized users.
  if (authRequired && isLoading) {
    return silent ? null : (
      <div className="p-8 text-center text-gray-500">กำลังตรวจสอบสิทธิ์...</div>
    );
  }

  // Strict mode + signed out → AuthProvider redirects to /login; render
  // nothing in the gap.
  if (authRequired && !user) return null;

  if (canAccessPage(role, page)) {
    return <>{children}</>;
  }

  if (silent) return null;

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-md mt-10 rounded-2xl border border-yellow-200 bg-white shadow-sm p-6 text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-yellow-700 font-semibold">
          CareU OPS
        </p>
        <h1 className="mt-2 text-2xl font-bold text-gray-900">
          ไม่มีสิทธิ์เข้าถึงหน้านี้
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          บทบาท &quot;{definition.labelTh}&quot;
          {" "}ไม่สามารถเข้าหน้านี้ได้ — เปลี่ยนบทบาทที่แถบด้านซ้าย
          หรือกลับไปยังหน้าหลัก
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <Link
            href="/"
            className="w-full rounded-xl bg-green-700 hover:bg-green-800 text-white font-semibold py-2.5"
          >
            กลับไปหน้าแดชบอร์ด
          </Link>
        </div>
      </div>
    </div>
  );
}

export default RouteGuard;
