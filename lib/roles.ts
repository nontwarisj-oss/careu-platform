// Enterprise role taxonomy — 5 canonical codes plus a legacy translator so
// old sessions / DB rows keep resolving after the rename.
//
// Canonical:
//   owner          — sees everything across all branches (CEO of the chain)
//   hq_admin       — manages pricing / promotions / staff / system data
//   branch_manager — owns one branch's operations + financials
//   front_staff    — creates orders, prints receipts, no financials
//   technician     — works assigned jobs, no financials
//
// Legacy 7-role codes (CEO, AREA_MANAGER, BRANCH_MANAGER, FRONT_DESK,
// TECHNICIAN, ACCOUNTANT, FRANCHISE_OWNER) auto-map below — DB audit rows
// stay valid, old session cookies still decode to a working role.

export type Role =
  | "owner"
  | "hq_admin"
  | "branch_manager"
  | "front_staff"
  | "technician";

export type DashboardKey =
  | "frontdesk"
  | "production"
  | "accounting"
  | "manager"
  | "executive";

export type PageKey =
  | "dashboard"
  | "intake"
  | "customers"
  | "orders"
  | "invoices"
  | "expenses"
  | "reports"
  | "pricing"
  | "admin";

export type RoleDefinition = {
  role: Role;
  labelTh: string;
  labelEn: string;
  /** Dashboards this role can open; the first entry is the default. */
  dashboards: DashboardKey[];
  /** Sidebar pages this role can navigate to. "*" means all pages. */
  pages: PageKey[] | ["*"];
  /** True = sees data across every branch. False = scoped to own branch. */
  allBranches: boolean;
  /** True = can see profit / margin / executive KPIs. */
  seesFinancials: boolean;
};

export const ROLE_DEFINITIONS: Record<Role, RoleDefinition> = {
  owner: {
    role: "owner",
    labelTh: "เจ้าของกิจการ",
    labelEn: "Owner",
    dashboards: ["executive", "manager", "accounting", "production", "frontdesk"],
    pages: ["*"],
    allBranches: true,
    seesFinancials: true,
  },
  hq_admin: {
    role: "hq_admin",
    labelTh: "แอดมินสำนักงานใหญ่",
    labelEn: "HQ admin",
    dashboards: ["manager", "executive", "accounting", "production", "frontdesk"],
    pages: ["*"],
    allBranches: true,
    seesFinancials: true,
  },
  branch_manager: {
    role: "branch_manager",
    labelTh: "ผู้จัดการสาขา",
    labelEn: "Branch manager",
    dashboards: ["manager", "frontdesk", "production", "accounting"],
    pages: [
      "dashboard",
      "intake",
      "customers",
      "orders",
      "invoices",
      "expenses",
      "reports",
      "pricing",
    ],
    allBranches: false,
    seesFinancials: true,
  },
  front_staff: {
    role: "front_staff",
    labelTh: "พนักงานหน้าร้าน",
    labelEn: "Front staff",
    dashboards: ["frontdesk"],
    pages: ["dashboard", "intake", "customers", "orders"],
    allBranches: false,
    seesFinancials: false,
  },
  technician: {
    role: "technician",
    labelTh: "ช่างซ่อม",
    labelEn: "Technician",
    dashboards: ["production"],
    pages: ["dashboard", "orders"],
    allBranches: false,
    seesFinancials: false,
  },
};

// Until LINE login is configured the preview mode defaults to owner so the
// platform demos with full access. The real role comes from the session
// once Supabase Auth lands.
export const DEFAULT_ROLE: Role = "owner";

export const DASHBOARD_LABELS: Record<DashboardKey, { th: string; en: string }> = {
  frontdesk: { th: "Front Desk", en: "Front Desk" },
  production: { th: "Production", en: "Production" },
  accounting: { th: "Accounting", en: "Accounting" },
  manager: { th: "Manager", en: "Manager" },
  executive: { th: "Executive", en: "Executive" },
};

// Legacy code → canonical Role. Covers both the original 7-role names and
// the very first short-code set so cookies / DB rows from any prior version
// still resolve to a sensible role.
const LEGACY_ROLE_MAP: Record<string, Role> = {
  // Pre-pricing 7-role set
  ceo: "owner",
  area_manager: "owner",
  branch_manager: "branch_manager",
  front_desk: "front_staff",
  technician: "technician",
  accountant: "hq_admin",
  franchise_owner: "branch_manager",
  // Original short-code set
  frontdesk: "front_staff",
  qc: "technician",
  accounting: "hq_admin",
  manager: "branch_manager",
  executive: "owner",
  admin: "owner",
};

/** Translate an old code or unknown input to a valid Role. */
export function normalizeRole(value: string | null | undefined): Role {
  if (!value) return DEFAULT_ROLE;
  const lower = value.toLowerCase();
  if (lower in ROLE_DEFINITIONS) return lower as Role;
  const mapped = LEGACY_ROLE_MAP[lower];
  if (mapped) return mapped;
  return DEFAULT_ROLE;
}

export function getRoleDefinition(role: Role): RoleDefinition {
  return ROLE_DEFINITIONS[role] ?? ROLE_DEFINITIONS[DEFAULT_ROLE];
}

export function canAccessPage(role: Role, page: PageKey): boolean {
  const def = getRoleDefinition(role);
  return (
    (def.pages as readonly string[]).includes("*") ||
    (def.pages as readonly string[]).includes(page)
  );
}

export function getAccessibleDashboards(role: Role): DashboardKey[] {
  return getRoleDefinition(role).dashboards;
}

export function getDefaultDashboard(role: Role): DashboardKey {
  return getAccessibleDashboards(role)[0];
}

export function seesAllBranches(role: Role): boolean {
  return getRoleDefinition(role).allBranches;
}

export function seesFinancials(role: Role): boolean {
  return getRoleDefinition(role).seesFinancials;
}
