// Capability helpers. Centralises every UI-level permission check so role
// changes only need to be made in one place. Pure functions over Role —
// safe to import from server or client code.
//
// IMPORTANT: these are UI guards, not the real enforcement layer. Database
// RLS (next migration) is what actually prevents cross-branch reads when
// Supabase Auth is wired. Keep the two policies aligned.

import { getRoleDefinition, type Role } from "@/lib/roles";

export function canViewAllBranches(role: Role): boolean {
  return getRoleDefinition(role).allBranches;
}

export function canViewReports(role: Role): boolean {
  // Reports include profit / margin numbers, so they're gated on financials
  // visibility — front staff and technician see the operational dashboards
  // but not the reports section.
  return getRoleDefinition(role).seesFinancials;
}

export function canCreateOrder(role: Role): boolean {
  return role === "owner" || role === "hq_admin" || role === "branch_manager" || role === "front_staff";
}

export function canEditOrder(role: Role): boolean {
  // Technicians can update job status only; the order page enforces the
  // narrower technician path inline.
  return role !== "technician" ? true : true;
}

export function canManagePricing(role: Role): boolean {
  return role === "owner" || role === "hq_admin";
}

export function canManageStaff(role: Role): boolean {
  return role === "owner" || role === "hq_admin";
}

export function canSeeFinancials(role: Role): boolean {
  return getRoleDefinition(role).seesFinancials;
}

export function canChooseAnotherBranch(role: Role): boolean {
  return canViewAllBranches(role);
}

/** True when the user can edit costs (labor / material) on an order. */
export function canEditOrderCosts(role: Role): boolean {
  return role === "owner" || role === "hq_admin" || role === "branch_manager";
}

/** True when the user can change job status. Technicians need this. */
export function canChangeJobStatus(role: Role): boolean {
  return (
    role === "owner" ||
    role === "hq_admin" ||
    role === "branch_manager" ||
    role === "front_staff" ||
    role === "technician"
  );
}
