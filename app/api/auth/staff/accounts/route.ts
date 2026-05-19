// /api/auth/staff/accounts — owner / hq_admin staff-credential management.
//
// GET  → list every staff_accounts row (never password_hash) + branch options.
// POST → { action: "create" }  add a staff login.
//        { action: "update" }  edit role / branch / active / reset password.
//
// staff_accounts is RLS-on / no-policy, so all access goes through the
// service-role client. The operator session is required and gated to
// owner / hq_admin.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentUser, type CurrentUser } from "@/lib/supabaseAuth";
import { hashPassword } from "@/lib/passwords";
import { normalizeRole } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MANAGE_ROLES = ["owner", "hq_admin"];
const VALID_ROLES = new Set([
  "owner",
  "hq_admin",
  "branch_manager",
  "front_staff",
  "technician",
]);
const MIN_PASSWORD = 8;

type Guard = { ok: true; user: CurrentUser } | { ok: false; res: NextResponse };

async function requireManager(): Promise<Guard> {
  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false,
      res: NextResponse.json(
        { ok: false, reason: "ยังไม่ได้เข้าสู่ระบบ" },
        { status: 401 }
      ),
    };
  }
  if (!MANAGE_ROLES.includes(user.role)) {
    return {
      ok: false,
      res: NextResponse.json(
        { ok: false, reason: "เฉพาะ Owner / Admin เท่านั้น" },
        { status: 403 }
      ),
    };
  }
  return { ok: true, user };
}

export async function GET() {
  const guard = await requireManager();
  if (!guard.ok) return guard.res;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "service role ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  const accRes = await admin
    .from("staff_accounts")
    .select(
      "id, employee_code, full_name, role, branch_id, active, last_login_at, created_at"
    )
    .order("created_at", { ascending: true });
  if (accRes.error) {
    return NextResponse.json(
      { ok: false, reason: accRes.error.message },
      { status: 500 }
    );
  }

  // Branch options — branches.code is the slug stored on staff_accounts.branch_id.
  const branchRes = await admin
    .from("branches")
    .select("code, name")
    .order("code", { ascending: true });
  const branches = (
    (branchRes.data ?? []) as Array<Record<string, unknown>>
  ).map((b) => ({
    code: String(b.code ?? ""),
    name: String(b.name ?? b.code ?? ""),
  }));

  return NextResponse.json({
    ok: true,
    accounts: accRes.data ?? [],
    branches,
  });
}

type PostBody = {
  action?: string;
  id?: string;
  employeeCode?: string;
  password?: string;
  fullName?: string;
  role?: string;
  branchId?: string | null;
  active?: boolean;
};

export async function POST(req: Request) {
  const guard = await requireManager();
  if (!guard.ok) return guard.res;
  const me = guard.user;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "service role ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "รูปแบบคำขอไม่ถูกต้อง" },
      { status: 400 }
    );
  }

  // ---- create -----------------------------------------------------------
  if (body.action === "create") {
    const employeeCode = (body.employeeCode ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    const fullName = (body.fullName ?? "").trim();
    const role = normalizeRole(body.role);
    if (!employeeCode || !fullName) {
      return NextResponse.json(
        { ok: false, reason: "ต้องระบุรหัสพนักงานและชื่อ-นามสกุล" },
        { status: 400 }
      );
    }
    if (!VALID_ROLES.has(role)) {
      return NextResponse.json(
        { ok: false, reason: `บทบาท "${body.role}" ไม่ถูกต้อง` },
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
        role,
        branch_id: body.branchId?.trim() || null,
        active: true,
      })
      .select("id")
      .single();
    if (insertRes.error || !insertRes.data) {
      if (insertRes.error?.code === "23505") {
        return NextResponse.json(
          { ok: false, reason: "รหัสพนักงานนี้ถูกใช้แล้ว" },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { ok: false, reason: insertRes.error?.message ?? "สร้างบัญชีไม่สำเร็จ" },
        { status: 500 }
      );
    }
    return NextResponse.json({
      ok: true,
      id: (insertRes.data as { id: string }).id,
    });
  }

  // ---- update -----------------------------------------------------------
  if (body.action === "update") {
    const id = (body.id ?? "").trim();
    if (!id) {
      return NextResponse.json(
        { ok: false, reason: "ต้องระบุบัญชีที่จะแก้ไข" },
        { status: 400 }
      );
    }
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (body.fullName !== undefined) {
      const fullName = body.fullName.trim();
      if (!fullName) {
        return NextResponse.json(
          { ok: false, reason: "ชื่อ-นามสกุลห้ามว่าง" },
          { status: 400 }
        );
      }
      patch.full_name = fullName;
    }
    if (body.role !== undefined) {
      const role = normalizeRole(body.role);
      if (!VALID_ROLES.has(role)) {
        return NextResponse.json(
          { ok: false, reason: `บทบาท "${body.role}" ไม่ถูกต้อง` },
          { status: 400 }
        );
      }
      patch.role = role;
    }
    if (body.branchId !== undefined) {
      patch.branch_id = body.branchId?.trim() || null;
    }
    if (body.active !== undefined) {
      // Guard against an operator locking themselves out.
      if (body.active === false && id === me.uid) {
        return NextResponse.json(
          { ok: false, reason: "ปิดใช้งานบัญชีของตัวเองไม่ได้" },
          { status: 400 }
        );
      }
      patch.active = body.active;
    }
    if (body.password !== undefined && body.password !== "") {
      if (body.password.length < MIN_PASSWORD) {
        return NextResponse.json(
          { ok: false, reason: `รหัสผ่านต้องมีอย่างน้อย ${MIN_PASSWORD} ตัวอักษร` },
          { status: 400 }
        );
      }
      patch.password_hash = hashPassword(body.password);
    }
    if (Object.keys(patch).length === 1) {
      return NextResponse.json(
        { ok: false, reason: "ไม่มีข้อมูลที่จะแก้ไข" },
        { status: 400 }
      );
    }

    const res = await admin
      .from("staff_accounts")
      .update(patch)
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (res.error) {
      return NextResponse.json(
        { ok: false, reason: res.error.message },
        { status: 500 }
      );
    }
    if (!res.data) {
      return NextResponse.json(
        { ok: false, reason: "ไม่พบบัญชีนี้" },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { ok: false, reason: `ไม่รู้จัก action "${body.action}"` },
    { status: 400 }
  );
}
