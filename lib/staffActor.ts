// Server-side resolution of the acting staff member.
//
// Internal staff login is localStorage-based (no SESSION_SECRET, no signed
// cookie — see lib/simpleStaffSession.ts), so a protected route identifies
// the caller in one of two ways, in order:
//
//   1. A signed session cookie — LINE login, or staff login on a deployment
//      where SESSION_SECRET happens to be configured. Strongest signal.
//   2. The x-careu-staff-id header — the "simple staff auth" path. The id is
//      VALIDATED against staff_accounts: it must be a real, active row. This
//      is claimed-identity (forgeable on the wire) — adequate for a small-shop
//      back office, deliberately not a hardened trust boundary.
//
// Server-only. Never import from a "use client" file.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "@/lib/supabaseAuth";
import { normalizeRole, type Role } from "@/lib/roles";

export type StaffActor = {
  uid: string;
  role: Role;
  branchId: string | null;
  source: "cookie" | "staff_account";
};

/**
 * Resolve the acting staff member. `claimedStaffId` is the value of the
 * x-careu-staff-id request header. Returns null when neither path identifies
 * a valid, active operator.
 */
export async function resolveStaffActor(
  admin: SupabaseClient,
  claimedStaffId: string | null | undefined
): Promise<StaffActor | null> {
  // 1. Signed cookie session — the stronger signal when present.
  const cookieUser = await getCurrentUser();
  if (cookieUser) {
    return {
      uid: cookieUser.uid,
      role: cookieUser.role,
      branchId: cookieUser.branchId,
      source: "cookie",
    };
  }

  // 2. Simple staff auth — validate the claimed id against staff_accounts.
  const id = (claimedStaffId ?? "").trim();
  if (!id) return null;
  const res = await admin
    .from("staff_accounts")
    .select("id, role, branch_id, active")
    .eq("id", id)
    .maybeSingle();
  if (res.error || !res.data) return null;
  const row = res.data as {
    id: string;
    role: string | null;
    branch_id: string | null;
    active: boolean | null;
  };
  if (row.active === false) return null;
  return {
    uid: row.id,
    role: normalizeRole(row.role),
    branchId: row.branch_id,
    source: "staff_account",
  };
}
