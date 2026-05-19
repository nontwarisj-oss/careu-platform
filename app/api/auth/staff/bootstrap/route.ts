// /api/auth/staff/bootstrap — one-time owner seed for internal staff login.
//
// GET  → { needed: boolean } — true while public.staff_accounts is empty, so
//        /login can render the first-run setup form.
// POST → creates the first account as `owner` and signs it straight in.
//        Self-disabling: once any staff account exists it returns 403 forever.
//
// Mirrors the existing "first LINE user becomes owner" bootstrap in the LINE
// callback — no password ships in git; the owner sets their own.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  encodeSession,
  isSessionConfigured,
  setSessionCookie,
} from "@/lib/session";
import { hashPassword } from "@/lib/passwords";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MIN_PASSWORD = 8;

type Body = {
  employeeCode?: unknown;
  password?: unknown;
  fullName?: unknown;
};

export async function GET() {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({
      ok: false,
      needed: false,
      reason: "service role ยังไม่ได้ตั้งค่า",
    });
  }
  const countRes = await admin
    .from("staff_accounts")
    .select("id", { count: "exact", head: true });
  if (countRes.error) {
    // Table missing / unreachable — treat as "not ready" rather than throwing.
    return NextResponse.json({
      ok: false,
      needed: false,
      reason: countRes.error.message,
    });
  }
  return NextResponse.json({ ok: true, needed: (countRes.count ?? 0) === 0 });
}

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

  // Self-disabling — only works while staff_accounts is empty.
  const countRes = await admin
    .from("staff_accounts")
    .select("id", { count: "exact", head: true });
  if (countRes.error) {
    return NextResponse.json(
      { ok: false, reason: countRes.error.message },
      { status: 500 }
    );
  }
  if ((countRes.count ?? 0) > 0) {
    return NextResponse.json(
      { ok: false, reason: "ระบบมีบัญชีพนักงานอยู่แล้ว — ใช้หน้าเข้าสู่ระบบตามปกติ" },
      { status: 403 }
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
  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  if (!employeeCode || !password || !fullName) {
    return NextResponse.json(
      { ok: false, reason: "กรุณากรอกรหัสพนักงาน รหัสผ่าน และชื่อ-นามสกุล" },
      { status: 400 }
    );
  }
  if (password.length < MIN_PASSWORD) {
    return NextResponse.json(
      { ok: false, reason: `รหัสผ่านต้องมีอย่างน้อย ${MIN_PASSWORD} ตัวอักษร` },
      { status: 400 }
    );
  }

  const insertRes = await admin
    .from("staff_accounts")
    .insert({
      employee_code: employeeCode,
      password_hash: hashPassword(password),
      full_name: fullName,
      role: "owner",
      branch_id: null,
      active: true,
    })
    .select("id, full_name")
    .single();
  if (insertRes.error || !insertRes.data) {
    // 23505 — a race created the first account between our count and insert.
    if (insertRes.error?.code === "23505") {
      return NextResponse.json(
        { ok: false, reason: "ระบบมีบัญชีพนักงานอยู่แล้ว" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { ok: false, reason: insertRes.error?.message ?? "สร้างบัญชีไม่สำเร็จ" },
      { status: 500 }
    );
  }
  const owner = insertRes.data as { id: string; full_name: string };

  // Sign the new owner straight in.
  const encoded = encodeSession({
    uid: owner.id,
    sub: null,
    role: "owner",
    branchId: null,
    name: owner.full_name,
  });
  if (encoded) await setSessionCookie(encoded);

  return NextResponse.json({ ok: true, signedIn: !!encoded });
}
