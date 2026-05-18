// Phase J — production queue + technician recommendation + daily KPI.
//
// Server-side only: every function takes a Supabase client (the API routes
// pass the service-role admin client). No pricing/queue logic lives in a
// React component — pages call the routes, routes call these functions.
//
// Backed by the Phase J tables: public.technicians, technician_skills, and
// work_assignments (migration 20260560 — self-contained).

import type { SupabaseClient } from "@supabase/supabase-js";

// ---------- Vocabulary -----------------------------------------------------

export type AssignmentPriority = "NORMAL" | "URGENT" | "DUE_SOON";
export type AssignmentStatus =
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "QC_WAITING"
  | "REWORK"
  | "DONE"
  | "CANCELLED";
export type SkillLevel = "BASIC" | "STANDARD" | "ADVANCED" | "SPECIALIST";

export const ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  "ASSIGNED",
  "IN_PROGRESS",
  "QC_WAITING",
  "REWORK",
  "DONE",
  "CANCELLED",
];
export const SKILL_LEVELS: SkillLevel[] = [
  "BASIC",
  "STANDARD",
  "ADVANCED",
  "SPECIALIST",
];

export const ASSIGNMENT_STATUS_LABELS_TH: Record<AssignmentStatus, string> = {
  ASSIGNED: "มอบหมายแล้ว",
  IN_PROGRESS: "กำลังทำ",
  QC_WAITING: "รอตรวจ QC",
  REWORK: "แก้ไขงาน",
  DONE: "เสร็จ",
  CANCELLED: "ยกเลิก",
};

export const PRIORITY_LABELS_TH: Record<AssignmentPriority, string> = {
  NORMAL: "ปกติ",
  URGENT: "ด่วน",
  DUE_SOON: "ใกล้ถึงกำหนด",
};

export function isAssignmentStatus(v: unknown): v is AssignmentStatus {
  return (
    typeof v === "string" && (ASSIGNMENT_STATUSES as string[]).includes(v)
  );
}
export function isSkillLevel(v: unknown): v is SkillLevel {
  return typeof v === "string" && (SKILL_LEVELS as string[]).includes(v);
}

// Order statuses that are "closed" — never enter the production queue.
const CLOSED_ORDER_STATUSES = new Set([
  "cancelled",
  "completed",
  "ready-for-pickup",
]);

// ---------- Types ----------------------------------------------------------

export type QueueOrder = {
  id: string;
  jobId: string | null;
  customerName: string;
  itemName: string;
  serviceCode: string | null;
  serviceCategory: string | null;
  price: number;
  paymentStatus: string;
  status: string;
  urgent: boolean;
  dueDate: string | null;
  createdAt: string;
  branchId: string | null;
  priority: AssignmentPriority;
};

export type TechnicianSkill = {
  id: string;
  categoryTh: string | null;
  subcategoryTh: string | null;
  serviceCode: string | null;
  skillLevel: SkillLevel;
  preferred: boolean;
};

export type TechnicianForRec = {
  id: string;
  displayName: string;
  /** Branch code slug — matches orders.branch_id directly. */
  branchId: string | null;
  active: boolean;
  dailyWage: number | null;
  targetMultiplier: number;
  dailyCapacityItems: number | null;
  skills: TechnicianSkill[];
  assignedValueToday: number;
  assignedCountToday: number;
};

export type TechnicianRecommendation = {
  technicianId: string;
  displayName: string;
  score: number;
  reasonsTh: string[];
  warningsTh: string[];
};

export type TechnicianDailyKpi = {
  technicianId: string;
  date: string;
  dailyWage: number;
  targetMultiplier: number;
  targetWorkValue: number;
  assignedWorkValueToday: number;
  completedWorkValueToday: number;
  assignedJobCount: number;
  completedJobCount: number;
  targetPercentage: number;
};

// ---------- Helpers --------------------------------------------------------

/** True for a paid order — case-insensitive, tolerant of "PAID". */
export function isPaidStatus(paymentStatus: string | null | undefined): boolean {
  return (paymentStatus ?? "").trim().toLowerCase() === "paid";
}

/** Effective daily production target (Baht) — daily_wage × target_multiplier. */
export function effectiveDailyTarget(tech: {
  dailyWage: number | null;
  targetMultiplier: number;
}): number {
  if (tech.dailyWage != null && tech.dailyWage > 0) {
    return Number(tech.dailyWage) * Number(tech.targetMultiplier || 3);
  }
  return 0;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Days from now until `date` (date-only). Negative = overdue. */
function daysUntil(date: string | null): number | null {
  if (!date) return null;
  const d = new Date(`${date}T00:00:00`);
  if (!Number.isFinite(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

/** Priority of a queue order — URGENT > DUE_SOON (≤1 day) > NORMAL. */
export function orderPriority(
  urgent: boolean,
  dueDate: string | null
): AssignmentPriority {
  if (urgent) return "URGENT";
  const d = daysUntil(dueDate);
  if (d !== null && d <= 1) return "DUE_SOON";
  return "NORMAL";
}

// Progressive column tiers — the production `orders` table may lack the
// smart-order columns (urgent / due_date / job_id) on an un-migrated DB.
const ORDER_TIERS = [
  "id, job_id, customer_name, item_name, price, status, created_at, branch_id, payment_status, urgent, due_date, service_code, service_category",
  "id, job_id, customer_name, item_name, price, status, created_at, branch_id, payment_status",
  "id, customer_name, item_name, price, status, created_at, branch_id",
];

async function loadOrderRows(
  admin: SupabaseClient
): Promise<Array<Record<string, unknown>>> {
  for (const cols of ORDER_TIERS) {
    const res = await admin
      .from("orders")
      .select(cols)
      .order("created_at", { ascending: true });
    if (!res.error) {
      return (res.data ?? []) as unknown as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function rowToQueueOrder(row: Record<string, unknown>): QueueOrder {
  const itemName = String(row.item_name ?? "");
  // urgent flag may be a real column, or only encoded as "[ด่วน]" in the
  // legacy item_name fallback — honour both.
  const urgent =
    row.urgent === true || itemName.includes("ด่วน") || itemName.includes("[ด่วน]");
  const dueDate = row.due_date ? String(row.due_date).slice(0, 10) : null;
  return {
    id: String(row.id),
    jobId: row.job_id ? String(row.job_id) : null,
    customerName: String(row.customer_name ?? ""),
    itemName,
    serviceCode: row.service_code ? String(row.service_code) : null,
    serviceCategory: row.service_category
      ? String(row.service_category)
      : null,
    price: num(row.price),
    paymentStatus: String(row.payment_status ?? ""),
    status: String(row.status ?? ""),
    urgent,
    dueDate,
    createdAt: String(row.created_at ?? ""),
    branchId: row.branch_id ? String(row.branch_id) : null,
    priority: orderPriority(urgent, dueDate),
  };
}

// ---------- Queue ----------------------------------------------------------

/**
 * Paid orders with no active work_assignment — the raw unassigned set.
 * Excludes unpaid orders and closed (cancelled / completed / ready) ones.
 * `branchSlug` filters to one branch (orders.branch_id is the text slug).
 */
export async function getPaidUnassignedOrders(
  admin: SupabaseClient,
  branchSlug?: string | null
): Promise<QueueOrder[]> {
  const rows = await loadOrderRows(admin);

  // Order ids that already have a live (non-cancelled) assignment.
  const assignedRes = await admin
    .from("work_assignments")
    .select("order_id, status");
  const assigned = new Set<string>();
  if (!assignedRes.error) {
    for (const a of (assignedRes.data ?? []) as Array<{
      order_id: string;
      status: string;
    }>) {
      if (a.status !== "CANCELLED") assigned.add(String(a.order_id));
    }
  }

  const out: QueueOrder[] = [];
  for (const row of rows) {
    const order = rowToQueueOrder(row);
    if (!isPaidStatus(order.paymentStatus)) continue;
    if (CLOSED_ORDER_STATUSES.has(order.status.toLowerCase())) continue;
    if (assigned.has(order.id)) continue;
    if (branchSlug && order.branchId && order.branchId !== branchSlug) continue;
    out.push(order);
  }
  return out;
}

/**
 * The production queue — paid unassigned orders, sorted:
 *   1. URGENT, then DUE_SOON, then NORMAL
 *   2. due_date ascending, nulls last
 *   3. created_at ascending (oldest paid job first)
 */
export async function getProductionQueue(
  admin: SupabaseClient,
  branchSlug?: string | null
): Promise<QueueOrder[]> {
  const orders = await getPaidUnassignedOrders(admin, branchSlug);
  const priorityRank: Record<AssignmentPriority, number> = {
    URGENT: 0,
    DUE_SOON: 1,
    NORMAL: 2,
  };
  return orders.sort((a, b) => {
    if (priorityRank[a.priority] !== priorityRank[b.priority]) {
      return priorityRank[a.priority] - priorityRank[b.priority];
    }
    // due_date asc, nulls last
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) {
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    if (a.dueDate && !b.dueDate) return -1;
    if (!a.dueDate && b.dueDate) return 1;
    // created_at asc
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

// ---------- Recommendation -------------------------------------------------

const SKILL_LEVEL_RANK: Record<SkillLevel, number> = {
  BASIC: 1,
  STANDARD: 2,
  ADVANCED: 3,
  SPECIALIST: 4,
};

/**
 * Rank technicians for one order. Pure — the caller (queue route) loads the
 * technician set + their skills + today's load once and passes it in.
 *
 * Scoring: skill match (service_code > category) is heaviest; urgent jobs
 * favour ADVANCED/SPECIALIST; same-branch, head-room under the daily value
 * target, and free item-capacity all add; over-target / over-capacity are
 * surfaced as warnings (never a hard block).
 */
export function recommendTechniciansForOrder(
  order: QueueOrder,
  technicians: TechnicianForRec[]
): TechnicianRecommendation[] {
  const recs = technicians
    .filter((t) => t.active)
    .map<TechnicianRecommendation>((tech) => {
      const reasons: string[] = [];
      const warnings: string[] = [];
      let score = 0;

      // --- Skill match ---
      const codeSkill = order.serviceCode
        ? tech.skills.find((s) => s.serviceCode === order.serviceCode)
        : undefined;
      const catSkill =
        !codeSkill && order.serviceCategory
          ? tech.skills.find((s) => s.categoryTh === order.serviceCategory)
          : undefined;
      const matched = codeSkill ?? catSkill;
      if (codeSkill) {
        score += 60;
        reasons.push(`ตรงบริการ (${order.serviceCode})`);
      } else if (catSkill) {
        score += 35;
        reasons.push(`ตรงหมวด (${order.serviceCategory})`);
      } else {
        reasons.push("ไม่พบทักษะที่ตรง");
      }
      if (matched?.preferred) {
        score += 10;
        reasons.push("งานที่ถนัด");
      }

      // --- Urgent → prefer ADVANCED / SPECIALIST ---
      if (order.priority === "URGENT") {
        const lvl = matched?.skillLevel;
        if (lvl === "SPECIALIST" || lvl === "ADVANCED") {
          score += 25;
          reasons.push(`งานด่วน — ช่างระดับ ${lvl}`);
        } else if (lvl) {
          warnings.push(`งานด่วนแต่ช่างระดับ ${lvl}`);
        }
      }

      // --- Same branch (both are branch code slugs) ---
      if (order.branchId && tech.branchId && order.branchId === tech.branchId) {
        score += 10;
        reasons.push("สาขาเดียวกัน");
      }

      // --- Daily value head-room (3× wage target) ---
      const target = effectiveDailyTarget(tech);
      if (target > 0) {
        const util = tech.assignedValueToday / target;
        if (util < 0.6) {
          score += 20;
          reasons.push(`โหลดวันนี้ ${Math.round(util * 100)}% — ยังรับได้`);
        } else if (util < 1) {
          score += 8;
          reasons.push(`โหลดวันนี้ ${Math.round(util * 100)}%`);
        } else {
          score -= 8;
          warnings.push(`เกินเป้าค่างานวันนี้ (${Math.round(util * 100)}%)`);
        }
      } else {
        reasons.push("ยังไม่ตั้งค่าแรง/เป้าหมาย");
      }

      // --- Item capacity ---
      if (
        tech.dailyCapacityItems != null &&
        tech.dailyCapacityItems > 0 &&
        tech.assignedCountToday >= tech.dailyCapacityItems
      ) {
        score -= 6;
        warnings.push(
          `งานเต็มโควตา (${tech.assignedCountToday}/${tech.dailyCapacityItems} ชิ้น)`
        );
      }

      return {
        technicianId: tech.id,
        displayName: tech.displayName,
        score,
        reasonsTh: reasons,
        warningsTh: warnings,
      };
    });

  return recs.sort((a, b) => b.score - a.score);
}

// ---------- Daily KPI ------------------------------------------------------

/**
 * One technician's production KPI for a date. assigned/completed value is
 * the sum of the assigned orders' `price` (the order total).
 */
export async function calculateTechnicianDailyKpi(
  admin: SupabaseClient,
  technicianId: string,
  date: string
): Promise<TechnicianDailyKpi> {
  const techRes = await admin
    .from("technicians")
    .select("daily_wage, target_multiplier")
    .eq("id", technicianId)
    .maybeSingle();
  const tp = (techRes.data ?? {}) as {
    daily_wage?: number | string | null;
    target_multiplier?: number | string | null;
  };
  const dailyWage = tp.daily_wage != null ? num(tp.daily_wage) : 0;
  const targetMultiplier =
    tp.target_multiplier != null ? num(tp.target_multiplier) : 3;
  const targetWorkValue = effectiveDailyTarget({
    dailyWage: dailyWage || null,
    targetMultiplier,
  });

  // Assignments for the technician on that date (cancelled excluded).
  const aRes = await admin
    .from("work_assignments")
    .select("order_id, status")
    .eq("technician_id", technicianId)
    .eq("assigned_date", date);
  const assignments = ((aRes.data ?? []) as Array<{
    order_id: string;
    status: string;
  }>).filter((a) => a.status !== "CANCELLED");

  // Order value lookup.
  const orderIds = assignments.map((a) => a.order_id);
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
      priceById.set(String(o.id), num(o.price));
    }
  }

  let assignedValue = 0;
  let completedValue = 0;
  let assignedCount = 0;
  let completedCount = 0;
  for (const a of assignments) {
    const value = priceById.get(String(a.order_id)) ?? 0;
    assignedValue += value;
    assignedCount += 1;
    if (a.status === "DONE") {
      completedValue += value;
      completedCount += 1;
    }
  }

  return {
    technicianId,
    date,
    dailyWage,
    targetMultiplier,
    targetWorkValue,
    assignedWorkValueToday: Math.round(assignedValue * 100) / 100,
    completedWorkValueToday: Math.round(completedValue * 100) / 100,
    assignedJobCount: assignedCount,
    completedJobCount: completedCount,
    targetPercentage:
      targetWorkValue > 0
        ? Math.round((assignedValue / targetWorkValue) * 100)
        : 0,
  };
}
