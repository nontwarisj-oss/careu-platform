// Enterprise role taxonomy. These codes match public.roles (seeded by
// 20260520_auth_audit.sql) and are the values stored in `users.role` and
// the session cookie.
//
// Branch scoping rule of thumb:
//   all_branches = true   →  CEO, AREA_MANAGER, ACCOUNTANT
//   all_branches = false  →  every other role is pinned to users.branch_id

export type Role =
  | "CEO"
  | "AREA_MANAGER"
  | "BRANCH_MANAGER"
  | "FRONT_DESK"
  | "TECHNICIAN"
  | "ACCOUNTANT"
  | "FRANCHISE_OWNER";

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
  CEO: {
    role: "CEO",
    labelTh: "CEO",
    labelEn: "CEO",
    dashboards: ["executive", "manager", "accounting", "production", "frontdesk"],
    pages: ["*"],
    allBranches: true,
    seesFinancials: true,
  },
  AREA_MANAGER: {
    role: "AREA_MANAGER",
    labelTh: "ผู้จัดการเขต",
    labelEn: "Area manager",
    dashboards: ["manager", "executive", "accounting", "production", "frontdesk"],
    pages: ["*"],
    allBranches: true,
    seesFinancials: true,
  },
  BRANCH_MANAGER: {
    role: "BRANCH_MANAGER",
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
  FRONT_DESK: {
    role: "FRONT_DESK",
    labelTh: "พนักงานหน้าร้าน",
    labelEn: "Front desk",
    dashboards: ["frontdesk"],
    pages: ["dashboard", "intake", "customers", "orders"],
    allBranches: false,
    seesFinancials: false,
  },
  TECHNICIAN: {
    role: "TECHNICIAN",
    labelTh: "ช่างซ่อม",
    labelEn: "Technician",
    dashboards: ["production"],
    pages: ["dashboard", "orders"],
    allBranches: false,
    seesFinancials: false,
  },
  ACCOUNTANT: {
    role: "ACCOUNTANT",
    labelTh: "บัญชี",
    labelEn: "Accountant",
    dashboards: ["accounting"],
    pages: ["dashboard", "invoices", "customers", "expenses", "reports"],
    allBranches: true,
    seesFinancials: true,
  },
  FRANCHISE_OWNER: {
    role: "FRANCHISE_OWNER",
    labelTh: "เจ้าของแฟรนไชส์",
    labelEn: "Franchise owner",
    dashboards: ["manager", "frontdesk", "accounting"],
    pages: [
      "dashboard",
      "orders",
      "customers",
      "invoices",
      "expenses",
      "reports",
      "pricing",
    ],
    allBranches: false,
    seesFinancials: true,
  },
};

// Until LINE login is configured the preview mode defaults to CEO so the
// platform demos with full access. Once auth is required, this is only
// used for typing — the real role comes from the session cookie.
export const DEFAULT_ROLE: Role = "CEO";

export const DASHBOARD_LABELS: Record<DashboardKey, { th: string; en: string }> = {
  frontdesk: { th: "Front Desk", en: "Front Desk" },
  production: { th: "Production", en: "Production" },
  accounting: { th: "Accounting", en: "Accounting" },
  manager: { th: "Manager", en: "Manager" },
  executive: { th: "Executive", en: "Executive" },
};

const LEGACY_ROLE_MAP: Record<string, Role> = {
  frontdesk: "FRONT_DESK",
  technician: "TECHNICIAN",
  qc: "TECHNICIAN",
  accounting: "ACCOUNTANT",
  manager: "BRANCH_MANAGER",
  executive: "CEO",
  admin: "CEO",
};

/** Translate an old short code or unknown input to a valid Role. */
export function normalizeRole(value: string | null | undefined): Role {
  if (!value) return DEFAULT_ROLE;
  if (value in ROLE_DEFINITIONS) return value as Role;
  const mapped = LEGACY_ROLE_MAP[value.toLowerCase()];
  if (mapped) return mapped;
  return DEFAULT_ROLE;
}

export function getRoleDefinition(role: Role): RoleDefinition {
  return ROLE_DEFINITIONS[role] ?? ROLE_DEFINITIONS[DEFAULT_ROLE];
}

export function canAccessPage(role: Role, page: PageKey): boolean {
  const def = getRoleDefinition(role);
  return (def.pages as readonly string[]).includes("*") ||
    (def.pages as readonly string[]).includes(page);
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
