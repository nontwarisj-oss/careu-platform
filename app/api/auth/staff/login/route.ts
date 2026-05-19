// POST /api/auth/staff/login — internal staff sign-in (employee_code + password).
//
// Verifies credentials against public.staff_accounts (service-role; the table
// is RLS-on / no-policy) and, on success, mints the SAME HMAC `careu_session`
// cookie that LINE login uses — so getCurrentUser() and every protected route
// authenticate the staff user with no further change.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  encodeSession,
  isSessionConfigured,
  setSessionCookie,
} from "@/lib/session";
import { verifyPassword } from "@/lib/passwords";
import { normalizeRole } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { employeeCode?: unknown; password?: unknown };

export async function POST(req: Request) {
  if (!isSessionConfigured()) {
    return NextResponse.json(
      { ok: false, reason: "SESSION_SECRET ยังไม่ได้ตั้งค่าใน environment" },
      { status: 503 }
    );
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "รูปแบบคำขอไม่ถูกต้อง" },
      { status: 400 }
    );
  }
  const employeeCode =
    typeof body.employeeCode === "string"
      ? body.employeeCode.trim().toLowerCase()
      : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!employeeCode || !password) {
    return NextResponse.json(
      { ok: false, reason: "กรุณากรอกรหัสพนักงานและรหัสผ่าน" },
      { status: 400 }
    );
  }

  const res = await admin
    .from("staff_accounts")
    .select("id, password_hash, full_name, role, branch_id, active")
    .eq("employee_code", employeeCode)
    .maybeSingle();

  // One generic message — never reveal whether the code or the password was
  // the wrong part.
  const invalid = NextResponse.json(
    { ok: false, reason: "รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง" },
    { status: 401 }
  );
  if (res.error || !res.data) return invalid;

  const staff = res.data as {
    id: string;
    password_hash: string;
    full_name: string;
    role: string | null;
    branch_id: string | null;
    active: boolean | null;
  };
  if (staff.active === false) {
    return NextResponse.json(
      { ok: false, reason: "บัญชีนี้ถูกปิดใช้งาน ติดต่อผู้ดูแลระบบ" },
      { status: 403 }
    );
  }
  if (!verifyPassword(password, staff.password_hash)) return invalid;

  const role = normalizeRole(staff.role);
  const encoded = encodeSession({
    uid: staff.id,
    sub: null,
    role,
    branchId: staff.branch_id,
    name: staff.full_name,
  });
  if (!encoded) {
    return NextResponse.json(
      { ok: false, reason: "เซ็น session ไม่สำเร็จ — SESSION_SECRET อาจสั้นเกินไป" },
      { status: 500 }
    );
  }
  await setSessionCookie(encoded);

  // Best-effort — a failed timestamp write must not fail the login.
  await admin
    .from("staff_accounts")
    .update({ last_login_at: new Date().toISOString() })
    .eq("id", staff.id);

  return NextResponse.json({
    ok: true,
    user: { uid: staff.id, name: staff.full_name, role, branchId: staff.branch_id },
  });
}
