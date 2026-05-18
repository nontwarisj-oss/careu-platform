// Phase J — GET /api/production/queue.
//
// Returns the production queue (paid, unassigned orders, priority-sorted)
// with a technician recommendation per order. Recommendation only — the
// admin still picks + confirms on /production/queue.
//
// Service-role; best-effort owner/hq_admin/branch_manager gate. Branch-
// scoped roles see only their branch's queue.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { canViewAllBranches } from "@/lib/permissions";
import {
  getProductionQueue,
  recommendTechniciansForOrder,
  type SkillLevel,
  type TechnicianForRec,
  type TechnicianSkill,
} from "@/lib/productionQueue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const VIEW_ROLES = ["owner", "hq_admin", "branch_manager"];

export async function GET() {
  const user = await getCurrentUser();
  if (user && !VIEW_ROLES.includes(user.role)) {
    return NextResponse.json(
      { ok: false, error: "ไม่มีสิทธิ์เข้าถึงคิวงานช่าง" },
      { status: 403 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "service role ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  const branchScope =
    user && !canViewAllBranches(user.role) ? user.branchId : null;

  const queue = await getProductionQueue(admin, branchScope);

  // ---- Active technicians + skills --------------------------------------
  const techRes = await admin
    .from("technician_profiles")
    .select(
      "id, branch_id, display_name, active, daily_wage, monthly_salary, target_multiplier, productivity_target, daily_capacity_items, skill_tags"
    )
    .eq("active", true);
  const techRows = (techRes.data ?? []) as Array<Record<string, unknown>>;
  const techIds = techRows.map((t) => String(t.id));

  const skillsByTech = new Map<string, TechnicianSkill[]>();
  if (techIds.length > 0) {
    const sRes = await admin
      .from("technician_skills")
      .select("*")
      .in("technician_id", techIds);
    for (const s of (sRes.data ?? []) as Array<Record<string, unknown>>) {
      const key = String(s.technician_id);
      const skill: TechnicianSkill = {
        id: String(s.id),
        categoryTh: s.category_th ? String(s.category_th) : null,
        subcategoryTh: s.subcategory_th ? String(s.subcategory_th) : null,
        serviceCode: s.service_code ? String(s.service_code) : null,
        skillLevel: String(s.skill_level ?? "STANDARD") as SkillLevel,
        preferred: s.preferred === true,
      };
      const list = skillsByTech.get(key);
      if (list) list.push(skill);
      else skillsByTech.set(key, [skill]);
    }
  }

  // branches.id (uuid) → branches.code (slug), to match orders.branch_id.
  const brRes = await admin.from("branches").select("id, code");
  const codeById = new Map<string, string>();
  for (const b of (brRes.data ?? []) as Array<Record<string, unknown>>) {
    codeById.set(String(b.id), String(b.code ?? ""));
  }

  // ---- Today's load per technician (work value + item count) ------------
  const today = new Date().toISOString().slice(0, 10);
  const waRes = await admin
    .from("work_assignments")
    .select("technician_id, order_id, status")
    .eq("assigned_date", today);
  const todayAssignments = (
    (waRes.data ?? []) as Array<{
      technician_id: string;
      order_id: string;
      status: string;
    }>
  ).filter((a) => a.status !== "CANCELLED");

  const orderIds = Array.from(
    new Set(todayAssignments.map((a) => String(a.order_id)))
  );
  const priceById = new Map<string, number>();
  if (orderIds.length > 0) {
    const oRes = await admin
      .from("orders")
      .select("id, price")
      .in("id", orderIds);
    for (const o of (oRes.data ?? []) as Array<{
      id: string;
      price: number | string | null;
    }>) {
      priceById.set(String(o.id), Number(o.price) || 0);
    }
  }
  const loadByTech = new Map<string, { value: number; count: number }>();
  for (const a of todayAssignments) {
    const cur = loadByTech.get(a.technician_id) ?? { value: 0, count: 0 };
    cur.value += priceById.get(String(a.order_id)) ?? 0;
    cur.count += 1;
    loadByTech.set(a.technician_id, cur);
  }

  const technicians: TechnicianForRec[] = techRows.map((t) => {
    const load = loadByTech.get(String(t.id)) ?? { value: 0, count: 0 };
    return {
      id: String(t.id),
      displayName: String(t.display_name ?? ""),
      branchId: t.branch_id ? String(t.branch_id) : null,
      branchCode: t.branch_id
        ? codeById.get(String(t.branch_id)) ?? null
        : null,
      active: t.active !== false,
      dailyWage: t.daily_wage != null ? Number(t.daily_wage) : null,
      monthlySalary: t.monthly_salary != null ? Number(t.monthly_salary) : null,
      targetMultiplier:
        t.target_multiplier != null ? Number(t.target_multiplier) : 3,
      productivityTarget:
        t.productivity_target != null ? Number(t.productivity_target) : null,
      dailyCapacityItems:
        t.daily_capacity_items != null
          ? Number(t.daily_capacity_items)
          : null,
      skillTags: Array.isArray(t.skill_tags)
        ? (t.skill_tags as unknown[]).map((s) => String(s))
        : [],
      skills: skillsByTech.get(String(t.id)) ?? [],
      assignedValueToday: load.value,
      assignedCountToday: load.count,
    };
  });

  const queueWithRecs = queue.map((order) => ({
    order,
    recommendations: recommendTechniciansForOrder(order, technicians).slice(
      0,
      3
    ),
  }));

  return NextResponse.json({
    ok: true,
    queue: queueWithRecs,
    technicians: technicians.map((t) => ({
      id: t.id,
      displayName: t.displayName,
    })),
  });
}
