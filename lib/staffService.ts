// Staff management data layer. The admin/staff page is the single screen
// owner / hq_admin uses to:
//   • promote / demote a user
//   • move them between branches
//   • activate / deactivate
//   • link or create a technician_profiles row (with wage + skills)
//
// All writes go through the supabase anon client (bridge JWT in strict mode
// gives the caller owner / hq_admin RLS visibility). Reads list every
// profile across branches because admins need cross-branch visibility.
//
// Pure data — no React imports. Re-usable from server route handlers later.

import supabase from "@/lib/supabase";
import { normalizeRole, type Role } from "@/lib/roles";

// ---------- Types ---------------------------------------------------------

export type StaffRow = {
  id: string;
  fullName: string;
  phone: string | null;
  lineUserId: string | null;
  role: Role;
  /** branches.id (uuid) or null when unassigned. */
  branchId: string | null;
  /** Joined branches.code text slug — matches orders.branch_id. */
  branchCode: string | null;
  /** Joined branches.name for display. */
  branchName: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  /** technician_profiles row when this staff is also a technician. */
  technician: StaffTechnician | null;
};

export type StaffTechnician = {
  id: string;
  displayName: string;
  active: boolean;
  skillTags: string[];
  dailyWage: number | null;
  targetMultiplier: number;
  productivityTarget: number | null;
};

export type BranchOption = {
  id: string;
  code: string;
  shortCode: string | null;
  name: string;
};

export type RoleUpdate = {
  role: Role;
  /** branches.id (uuid) or null to unassign. */
  branchId: string | null;
  isActive: boolean;
};

export type TechnicianUpdate = {
  displayName: string;
  active: boolean;
  skillTags: string[];
  dailyWage: number | null;
  targetMultiplier: number;
  productivityTarget: number | null;
  /** branches.id (uuid). Required when creating a new technician row. */
  branchId: string | null;
};

// ---------- Reads ---------------------------------------------------------

const PROFILE_COLUMNS = `
  id, full_name, phone, line_user_id, role, branch_id, is_active, last_login_at,
  branches:branch_id (id, code, name),
  technician_profiles:technician_profiles!user_id (
    id, display_name, active, skill_tags, daily_wage,
    target_multiplier, productivity_target
  )
`;

type RawProfileRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  line_user_id: string | null;
  role: string | null;
  branch_id: string | null;
  is_active: boolean | null;
  last_login_at: string | null;
  branches: { id: string; code: string; name: string } | { id: string; code: string; name: string }[] | null;
  technician_profiles: RawTechRow | RawTechRow[] | null;
};

type RawTechRow = {
  id: string;
  display_name: string;
  active: boolean;
  skill_tags: string[] | null;
  daily_wage: number | string | null;
  target_multiplier: number | string | null;
  productivity_target: number | string | null;
};

function toStaffRow(row: RawProfileRow): StaffRow {
  const branchRow = Array.isArray(row.branches) ? row.branches[0] ?? null : row.branches;
  const techRow = Array.isArray(row.technician_profiles)
    ? row.technician_profiles[0] ?? null
    : row.technician_profiles;

  const technician: StaffTechnician | null = techRow
    ? {
        id: techRow.id,
        displayName: techRow.display_name,
        active: techRow.active,
        skillTags: techRow.skill_tags ?? [],
        dailyWage: techRow.daily_wage == null ? null : Number(techRow.daily_wage),
        targetMultiplier: Number(techRow.target_multiplier ?? 3),
        productivityTarget:
          techRow.productivity_target == null
            ? null
            : Number(techRow.productivity_target),
      }
    : null;

  return {
    id: row.id,
    fullName: row.full_name ?? "(ไม่ระบุชื่อ)",
    phone: row.phone,
    lineUserId: row.line_user_id,
    role: normalizeRole(row.role),
    branchId: row.branch_id,
    branchCode: branchRow?.code ?? null,
    branchName: branchRow?.name ?? null,
    isActive: row.is_active !== false,
    lastLoginAt: row.last_login_at,
    technician,
  };
}

export async function fetchStaffList(): Promise<{
  rows: StaffRow[];
  error: string | null;
}> {
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .order("full_name", { ascending: true });

  if (error) {
    return { rows: [], error: error.message };
  }
  const rows = (data ?? []).map((row) => toStaffRow(row as RawProfileRow));
  return { rows, error: null };
}

export async function fetchBranchOptions(): Promise<BranchOption[]> {
  const { data, error } = await supabase
    .from("branches")
    .select("id, code, short_code, name")
    .order("code", { ascending: true });
  if (error || !data) return [];
  return (
    data as Array<{
      id: string;
      code: string;
      short_code: string | null;
      name: string;
    }>
  ).map((b) => ({
    id: b.id,
    code: b.code,
    shortCode: b.short_code,
    name: b.name,
  }));
}

// ---------- Writes --------------------------------------------------------

export async function updateProfileRole(
  profileId: string,
  update: RoleUpdate
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("profiles")
    .update({
      role: update.role,
      branch_id: update.branchId,
      is_active: update.isActive,
    })
    .eq("id", profileId);
  return { error: error?.message ?? null };
}

/**
 * Upsert the technician_profiles row tied to a given profile. When the
 * caller passes `existingTechId` we update in place; otherwise we insert a
 * new row keyed to `user_id = profileId`.
 */
export async function upsertTechnicianProfile(
  profileId: string,
  existingTechId: string | null,
  update: TechnicianUpdate
): Promise<{ error: string | null; technicianId: string | null }> {
  const payload = {
    user_id: profileId,
    display_name: update.displayName,
    active: update.active,
    skill_tags: update.skillTags,
    daily_wage: update.dailyWage,
    target_multiplier: update.targetMultiplier,
    productivity_target: update.productivityTarget,
    branch_id: update.branchId,
  };

  if (existingTechId) {
    const { error } = await supabase
      .from("technician_profiles")
      .update(payload)
      .eq("id", existingTechId);
    return { error: error?.message ?? null, technicianId: existingTechId };
  }

  const { data, error } = await supabase
    .from("technician_profiles")
    .insert(payload)
    .select("id")
    .maybeSingle();
  return {
    error: error?.message ?? null,
    technicianId: (data as { id: string } | null)?.id ?? null,
  };
}

/** Quick toggle for technician active flag without opening the full edit panel. */
export async function setTechnicianActive(
  technicianId: string,
  active: boolean
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("technician_profiles")
    .update({ active })
    .eq("id", technicianId);
  return { error: error?.message ?? null };
}
