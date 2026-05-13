// Technician assignment + recommendation service.
//
// This is the "who should pick up this job?" layer. It owns:
//   • The canonical skill catalog the UI dropdown reads from.
//   • Mapping from a service (category / code) to the required skill.
//   • Fetching active technicians honouring branch isolation.
//   • Scoring + recommending technicians for a given order context.
//
// Scope discipline: recommendation only. Auto-assignment is a future phase.
// This module never writes to public.orders — it returns a ranked list and
// lets the UI / caller pick.

import supabase from "@/lib/supabase";

// ---------- Skill catalog --------------------------------------------------
//
// Skills are stored as text[] on technician_profiles. The catalog below is
// the canonical list the UI exposes, but the column accepts any string so
// HQ can extend without a code change. Adding a new skill = append a row
// here AND a one-shot UPDATE in SQL to backfill existing technicians.

export type Skill =
  | "alteration"
  | "jeans"
  | "zipper"
  | "embroidery"
  | "shoes"
  | "bags"
  | "luggage"
  | "leather"
  | "drycleaning"
  | "general";

export type SkillSpec = {
  code: Skill;
  labelTh: string;
  labelEn: string;
};

export const SKILL_CATALOG: readonly SkillSpec[] = [
  { code: "alteration",  labelTh: "ดัดแปลงตัดเย็บ",  labelEn: "Alteration" },
  { code: "jeans",       labelTh: "กางเกงยีนส์",     labelEn: "Jeans" },
  { code: "zipper",      labelTh: "ซิป",              labelEn: "Zipper" },
  { code: "embroidery",  labelTh: "งานปัก",           labelEn: "Embroidery" },
  { code: "shoes",       labelTh: "รองเท้า",          labelEn: "Shoes" },
  { code: "bags",        labelTh: "กระเป๋า",          labelEn: "Bags" },
  { code: "luggage",     labelTh: "กระเป๋าเดินทาง",  labelEn: "Luggage" },
  { code: "leather",     labelTh: "งานหนัง",          labelEn: "Leather" },
  { code: "drycleaning", labelTh: "ซักแห้ง",          labelEn: "Dry cleaning" },
  { code: "general",     labelTh: "ทั่วไป",            labelEn: "General" },
];

// Map from order.service_category → required skill (broad).
const CATEGORY_SKILL: Record<string, Skill> = {
  alteration: "alteration",
  repair: "general",
  leather: "leather",
  luggage: "luggage",
  drycleaning: "drycleaning",
  special: "general",
};

// Specific service_codes that need a narrower skill than their category.
const SERVICE_CODE_SKILL: Record<string, Skill> = {
  "REP-002": "zipper",
  "REP-002-PZ6": "zipper",
  "ALT-001-RCN": "jeans",
  "SPC-001": "embroidery",
  "LUG-001": "luggage",
  "LUG-002": "luggage",
  "LTH-001": "leather",
  "LTH-002": "leather",
};

export function resolveRequiredSkill(opts: {
  serviceCode?: string | null;
  serviceCategory?: string | null;
}): Skill {
  if (opts.serviceCode && opts.serviceCode in SERVICE_CODE_SKILL) {
    return SERVICE_CODE_SKILL[opts.serviceCode];
  }
  if (opts.serviceCategory && opts.serviceCategory in CATEGORY_SKILL) {
    return CATEGORY_SKILL[opts.serviceCategory];
  }
  return "general";
}

// ---------- Domain types ---------------------------------------------------

export type TechnicianProfile = {
  id: string;
  user_id: string | null;
  branch_id: string | null;   // branches.id (uuid)
  display_name: string;
  active: boolean;
  skill_tags: string[];
  daily_wage: number | null;
  target_multiplier: number;
  productivity_target: number | null;
  created_at: string;
  updated_at: string;
};

export type RecommendationContext = {
  /** branches.id (uuid) — required for branch isolation. */
  branchId: string;
  businessType?: "care_u" | "ezy_repair";
  serviceCategory?: string | null;
  serviceCode?: string | null;
  urgent?: boolean;
};

export type TechnicianRecommendation = {
  technician: TechnicianProfile;
  /** 0–100 (no hard cap; sorted descending). */
  score: number;
  /** Human-readable Thai bullets the UI can render under each name. */
  reasons: string[];
  /** Today's assigned production value (Baht). */
  workloadToday: number;
  /** Effective daily target (productivity_target ?? daily_wage × multiplier). */
  effectiveTarget: number;
};

const PROFILE_COLUMNS =
  "id, user_id, branch_id, display_name, active, skill_tags, daily_wage, target_multiplier, productivity_target, created_at, updated_at";

// ---------- Effective daily target ----------------------------------------

/**
 * Compute the technician's effective daily target.
 *   • explicit productivity_target  → wins
 *   • daily_wage × target_multiplier → fallback
 *   • neither set                    → 0 (no target tracking)
 */
export function effectiveDailyTarget(tech: TechnicianProfile): number {
  if (tech.productivity_target != null && tech.productivity_target > 0) {
    return Number(tech.productivity_target);
  }
  if (tech.daily_wage != null && tech.daily_wage > 0) {
    return Number(tech.daily_wage) * Number(tech.target_multiplier ?? 3);
  }
  return 0;
}

// ---------- Data fetchers --------------------------------------------------

/**
 * List active technicians in a branch. RLS on technician_profiles already
 * constrains the result to branches the caller can read, but we apply the
 * explicit branch filter too so admins (who see all branches) get a clean
 * per-branch list.
 */
export async function fetchActiveTechnicians(
  ctx: RecommendationContext
): Promise<TechnicianProfile[]> {
  const { data, error } = await supabase
    .from("technician_profiles")
    .select(PROFILE_COLUMNS)
    .eq("active", true)
    .eq("branch_id", ctx.branchId)
    .order("display_name", { ascending: true });
  if (error || !data) return [];
  return data as TechnicianProfile[];
}

type DailySnapshot = { technician_id: string; assigned_value: number };

async function fetchTodaySnapshot(
  technicianIds: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (technicianIds.length === 0) return result;
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("technician_daily_kpi")
    .select("technician_id, assigned_value")
    .eq("work_date", today)
    .in("technician_id", technicianIds);
  if (error || !data) return result;
  for (const row of data as DailySnapshot[]) {
    result.set(row.technician_id, Number(row.assigned_value ?? 0));
  }
  return result;
}

// ---------- Scoring + recommendation --------------------------------------

const SCORE_SKILL_EXACT = 50;
const SCORE_SKILL_GENERAL = 10;
const SCORE_WORKLOAD_LOW = 30;
const SCORE_WORKLOAD_MEDIUM = 15;
const SCORE_WORKLOAD_HIGH = 5;
const SCORE_WORKLOAD_OVER = -10;

/**
 * Rank active technicians for the given order context. Returns highest
 * score first. Caller decides how many to show — usually top 3.
 *
 *   • Skill match — heaviest weight. Exact skill > 'general' > nothing.
 *   • Workload — closer to 0% utilisation today wins. >100% is penalised
 *     but not zero (the tech can still take the work if there's no one else).
 *   • Inactive technicians are filtered out upstream.
 */
export async function recommendTechnician(
  ctx: RecommendationContext
): Promise<TechnicianRecommendation[]> {
  const techs = await fetchActiveTechnicians(ctx);
  if (techs.length === 0) return [];

  const today = await fetchTodaySnapshot(techs.map((t) => t.id));
  const requiredSkill = resolveRequiredSkill(ctx);

  const recommendations = techs.map<TechnicianRecommendation>((tech) => {
    const reasons: string[] = [];
    let score = 0;

    // Skill scoring
    if (tech.skill_tags?.includes(requiredSkill)) {
      score += SCORE_SKILL_EXACT;
      reasons.push(`ตรงทักษะ "${requiredSkill}"`);
    } else if (tech.skill_tags?.includes("general")) {
      score += SCORE_SKILL_GENERAL;
      reasons.push('ทักษะ "general" รองรับได้');
    } else {
      reasons.push(`ไม่ตรงทักษะ "${requiredSkill}"`);
    }

    // Workload scoring
    const workloadToday = today.get(tech.id) ?? 0;
    const target = effectiveDailyTarget(tech);
    const utilisation = target > 0 ? workloadToday / target : 0;

    if (target === 0) {
      // No target configured — neutral score, surface the gap.
      reasons.push("ยังไม่ตั้งเป้าหมายผลิต/ค่าแรง");
    } else if (utilisation < 0.5) {
      score += SCORE_WORKLOAD_LOW;
      reasons.push(`โหลดวันนี้ ${Math.round(utilisation * 100)}% — ว่างเยอะ`);
    } else if (utilisation < 0.85) {
      score += SCORE_WORKLOAD_MEDIUM;
      reasons.push(`โหลดวันนี้ ${Math.round(utilisation * 100)}%`);
    } else if (utilisation < 1.0) {
      score += SCORE_WORKLOAD_HIGH;
      reasons.push(`โหลดวันนี้ ${Math.round(utilisation * 100)}% — ใกล้เต็ม`);
    } else {
      score += SCORE_WORKLOAD_OVER;
      reasons.push(
        `เกินเป้า: ${Math.round(utilisation * 100)}% — มอบหมายเพิ่มก็ได้ แต่จะหนัก`
      );
    }

    return {
      technician: tech,
      score,
      reasons,
      workloadToday,
      effectiveTarget: target,
    };
  });

  recommendations.sort((a, b) => b.score - a.score);
  return recommendations;
}
