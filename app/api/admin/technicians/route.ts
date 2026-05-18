// Phase J — technician + skill management.
//
// GET  → list technicians (reuses public.technician_profiles) + their
//        technician_skills + the branch options.
// POST → { action: "saveTechnician" | "addSkill" | "deleteSkill" }.
//
// Service-role: technician_profiles RLS only lets `authenticated` read, so
// a cookieless browser sees nothing — the admin client is used so the page
// works. Best-effort owner/hq_admin gate (the /admin/technicians page is
// also RouteGuard-gated). Wage edits are owner/hq_admin only.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { isSkillLevel } from "@/lib/productionQueue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const ADMIN_ROLES = ["owner", "hq_admin"];

const TECH_COLUMNS =
  "id, branch_id, display_name, phone, active, employment_type, daily_wage, monthly_salary, target_multiplier, productivity_target, daily_capacity_items, note, skill_tags, created_at, updated_at";

function rowToTechnician(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    branchId: row.branch_id ? String(row.branch_id) : null,
    displayName: String(row.display_name ?? ""),
    phone: row.phone ? String(row.phone) : null,
    active: row.active !== false,
    employmentType: row.employment_type ? String(row.employment_type) : null,
    dailyWage: row.daily_wage != null ? Number(row.daily_wage) : null,
    monthlySalary: row.monthly_salary != null ? Number(row.monthly_salary) : null,
    targetMultiplier:
      row.target_multiplier != null ? Number(row.target_multiplier) : 3,
    productivityTarget:
      row.productivity_target != null ? Number(row.productivity_target) : null,
    dailyCapacityItems:
      row.daily_capacity_items != null
        ? Number(row.daily_capacity_items)
        : null,
    note: row.note ? String(row.note) : null,
    skillTags: Array.isArray(row.skill_tags)
      ? (row.skill_tags as unknown[]).map((s) => String(s))
      : [],
  };
}

function denied() {
  return NextResponse.json(
    { ok: false, error: "เฉพาะ Owner / Admin เท่านั้น" },
    { status: 403 }
  );
}

export async function GET() {
  const user = await getCurrentUser();
  if (user && !ADMIN_ROLES.includes(user.role)) return denied();

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "service role ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  const techRes = await admin
    .from("technician_profiles")
    .select(TECH_COLUMNS)
    .order("display_name", { ascending: true });
  if (techRes.error) {
    return NextResponse.json(
      { ok: false, error: techRes.error.message },
      { status: 500 }
    );
  }
  const techRows = (techRes.data ?? []) as Array<Record<string, unknown>>;
  const ids = techRows.map((t) => String(t.id));

  const skillsByTech = new Map<string, unknown[]>();
  if (ids.length > 0) {
    const sRes = await admin
      .from("technician_skills")
      .select("*")
      .in("technician_id", ids)
      .order("created_at", { ascending: true });
    for (const s of (sRes.data ?? []) as Array<Record<string, unknown>>) {
      const key = String(s.technician_id);
      const item = {
        id: String(s.id),
        categoryTh: s.category_th ? String(s.category_th) : null,
        subcategoryTh: s.subcategory_th ? String(s.subcategory_th) : null,
        serviceCode: s.service_code ? String(s.service_code) : null,
        skillLevel: String(s.skill_level ?? "STANDARD"),
        preferred: s.preferred === true,
      };
      const list = skillsByTech.get(key);
      if (list) list.push(item);
      else skillsByTech.set(key, [item]);
    }
  }

  const branchRes = await admin
    .from("branches")
    .select("id, code, name")
    .order("code", { ascending: true });
  const branches = ((branchRes.data ?? []) as Array<Record<string, unknown>>).map(
    (b) => ({
      id: String(b.id),
      code: String(b.code ?? ""),
      name: String(b.name ?? b.code ?? ""),
    })
  );

  const technicians = techRows.map((row) => ({
    ...rowToTechnician(row),
    skills: skillsByTech.get(String(row.id)) ?? [],
  }));

  return NextResponse.json({ ok: true, technicians, branches });
}

type PostBody = {
  action?: string;
  technician?: {
    id?: string;
    displayName?: string;
    phone?: string | null;
    branchId?: string | null;
    active?: boolean;
    employmentType?: string | null;
    dailyWage?: number | null;
    monthlySalary?: number | null;
    targetMultiplier?: number | null;
    dailyCapacityItems?: number | null;
    note?: string | null;
    skillTags?: string[];
  };
  skill?: {
    id?: string;
    technicianId?: string;
    categoryTh?: string | null;
    subcategoryTh?: string | null;
    serviceCode?: string | null;
    skillLevel?: string;
    preferred?: boolean;
  };
};

export async function POST(req: Request) {
  // Wage / skill edits are owner/hq_admin only — enforced when a session
  // is present (cookieless → the page's RouteGuard is the gate).
  const user = await getCurrentUser();
  if (user && !ADMIN_ROLES.includes(user.role)) return denied();

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "service role ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  // ---- saveTechnician ---------------------------------------------------
  if (body.action === "saveTechnician") {
    const t = body.technician ?? {};
    const name = (t.displayName ?? "").trim();
    if (!name) {
      return NextResponse.json(
        { ok: false, error: "ต้องระบุชื่อช่าง" },
        { status: 400 }
      );
    }
    const row: Record<string, unknown> = {
      display_name: name,
      phone: t.phone?.trim() || null,
      branch_id: t.branchId || null,
      active: t.active !== false,
      employment_type: t.employmentType?.trim() || null,
      daily_wage: t.dailyWage ?? null,
      monthly_salary: t.monthlySalary ?? null,
      target_multiplier: t.targetMultiplier != null ? t.targetMultiplier : 3,
      daily_capacity_items: t.dailyCapacityItems ?? null,
      note: t.note?.trim() || null,
    };
    if (Array.isArray(t.skillTags)) row.skill_tags = t.skillTags;

    if (t.id) {
      const res = await admin
        .from("technician_profiles")
        .update(row)
        .eq("id", t.id);
      if (res.error) {
        return NextResponse.json(
          { ok: false, error: res.error.message },
          { status: 500 }
        );
      }
      return NextResponse.json({ ok: true, id: t.id });
    }
    const res = await admin
      .from("technician_profiles")
      .insert(row)
      .select("id")
      .single();
    if (res.error || !res.data) {
      return NextResponse.json(
        { ok: false, error: res.error?.message ?? "เพิ่มช่างไม่สำเร็จ" },
        { status: 500 }
      );
    }
    return NextResponse.json({
      ok: true,
      id: (res.data as { id: string }).id,
    });
  }

  // ---- addSkill ---------------------------------------------------------
  if (body.action === "addSkill") {
    const s = body.skill ?? {};
    if (!s.technicianId) {
      return NextResponse.json(
        { ok: false, error: "ต้องระบุช่าง" },
        { status: 400 }
      );
    }
    const level = (s.skillLevel ?? "STANDARD").toUpperCase();
    if (!isSkillLevel(level)) {
      return NextResponse.json(
        { ok: false, error: `ระดับทักษะ "${s.skillLevel}" ไม่ถูกต้อง` },
        { status: 400 }
      );
    }
    if (!s.categoryTh?.trim() && !s.serviceCode?.trim()) {
      return NextResponse.json(
        { ok: false, error: "ต้องระบุหมวด หรือ service_code อย่างน้อยหนึ่งอย่าง" },
        { status: 400 }
      );
    }
    const res = await admin.from("technician_skills").insert({
      technician_id: s.technicianId,
      category_th: s.categoryTh?.trim() || null,
      subcategory_th: s.subcategoryTh?.trim() || null,
      service_code: s.serviceCode?.trim() || null,
      skill_level: level,
      preferred: s.preferred === true,
    });
    if (res.error) {
      return NextResponse.json(
        { ok: false, error: res.error.message },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true });
  }

  // ---- deleteSkill ------------------------------------------------------
  if (body.action === "deleteSkill") {
    const skillId = body.skill?.id;
    if (!skillId) {
      return NextResponse.json(
        { ok: false, error: "ต้องระบุ skill id" },
        { status: 400 }
      );
    }
    const res = await admin
      .from("technician_skills")
      .delete()
      .eq("id", skillId);
    if (res.error) {
      return NextResponse.json(
        { ok: false, error: res.error.message },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { ok: false, error: `ไม่รู้จัก action "${body.action}"` },
    { status: 400 }
  );
}
