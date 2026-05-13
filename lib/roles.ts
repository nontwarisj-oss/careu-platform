// Role-based access foundation. The frontend uses these constants as the
// single source of truth right now so we can preview each role without
// touching auth. Once Supabase Auth lands, public.roles + public.users +
// public.user_branch_access (see 20260516_rbac_finance.sql) become
// authoritative and this file will hydrate from them.

export type Role =
  | "frontdesk"
  | "technician"
  | "qc"
  | "accounting"
  | "manager"
  | "executive"
  | "admin";

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
  | "pricing";

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
  frontdesk: {
    role: "frontdesk",
    labelTh: "พนักงานหน้าร้าน",
    labelEn: "Front desk",
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
  qc: {
    role: "qc",
    labelTh: "QC",
    labelEn: "QC",
    dashboards: ["production"],
    pages: ["dashboard", "orders"],
    allBranches: false,
    seesFinancials: false,
  },
  accounting: {
    role: "accounting",
    labelTh: "บัญชี",
    labelEn: "Accounting",
    dashboards: ["accounting"],
    pages: ["dashboard", "invoices", "customers", "expenses", "reports"],
    allBranches: true,
    seesFinancials: true,
  },
  manager: {
    role: "manager",
    labelTh: "ผู้จัดการสาขา",
    labelEn: "Manager",
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
  executive: {
    role: "executive",
    labelTh: "ผู้บริหาร (CEO)",
    labelEn: "Executive",
    dashboards: ["executive", "manager", "accounting", "production", "frontdesk"],
    pages: ["*"],
    allBranches: true,
    seesFinancials: true,
  },
  admin: {
    role: "admin",
    labelTh: "ผู้ดูแลระบบ",
    labelEn: "Admin",
    dashboards: ["executive", "manager", "accounting", "production", "frontdesk"],
    pages: ["*"],
    allBranches: true,
    seesFinancials: true,
  },
};

// Until real auth is wired, default to executive so the user previewing the
// platform sees everything. Role can be switched live via the sidebar.
export const DEFAULT_ROLE: Role = "executive";

export const DASHBOARD_LABELS: Record<DashboardKey, { th: string; en: string }> = {
  frontdesk: { th: "Front Desk", en: "Front Desk" },
  production: { th: "Production", en: "Production" },
  accounting: { th: "Accounting", en: "Accounting" },
  manager: { th: "Manager", en: "Manager" },
  executive: { th: "Executive", en: "Executive" },
};

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
