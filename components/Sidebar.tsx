"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/lib/languageContext";
import { useBranch } from "@/lib/branchContext";
import { useRole } from "@/lib/roleContext";
import { useAuth } from "@/lib/authContext";
import { canAccessPage, type PageKey, type Role } from "@/lib/roles";
import { t } from "@/lib/translations";
import { BrandLogo } from "@/components/BrandLogo";

type NavGroup = "ops" | "money" | "admin";

interface NavItem {
  href: string;
  page: PageKey;
  group: NavGroup;
  labelTh: string;
  labelEn: string;
  iconPath: string;
}

const ICON_PATHS = {
  dashboard: "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z",
  intake:
    "M19 3h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm0 5l4 4h-3v4h-2v-4H8l4-4z",
  customers:
    "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
  orders:
    "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z",
  invoices:
    "M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z",
  expenses:
    "M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1H6.32c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z",
  reports:
    "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14H7v-7h3v7zm4 0h-3V7h3v10zm4 0h-3v-4h3v4z",
  pricing:
    "M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z",
  admin:
    "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 6c1.4 0 2.5 1.1 2.5 2.5S13.4 12 12 12s-2.5-1.1-2.5-2.5S10.6 7 12 7zm0 13c-2.03-.5-3.96-2.39-4.74-4.61C8.34 14.69 9.46 14 12 14s3.66.69 4.74 1.39C15.96 17.61 14.03 19.5 12 20z",
  recovery:
    "M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8c-.45-.83-.7-1.79-.7-2.8 0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z",
};

const GROUP_LABELS: Record<NavGroup, { th: string; en: string }> = {
  ops: { th: "ปฏิบัติงาน", en: "Operations" },
  money: { th: "การเงิน", en: "Finance" },
  admin: { th: "จัดการระบบ", en: "Management" },
};

const Icon = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    className="w-5 h-5 shrink-0"
    fill="currentColor"
    aria-hidden
  >
    <path d={d} />
  </svg>
);

const Sidebar: React.FC = () => {
  const pathname = usePathname();
  const { language, setLanguage } = useLanguage();
  const { branch, setBranchId, branches } = useBranch();
  const { role, setRole, definition, roles } = useRole();
  const { user, isAuthenticated, isPreview, signOut } = useAuth();
  const [isOpen, setIsOpen] = useState(false);

  // /login renders its own full-screen card — hide the chrome there.
  if (pathname === "/login") return null;
  // Public website pages have their own header; the OPS sidebar must not
  // appear there. Keep this list in sync with PUBLIC_PREFIXES in
  // lib/authContext.tsx.
  const PUBLIC_PREFIXES = [
    "/website",
    "/branches",
    "/services",
    "/track",
    "/quote",
    "/about",
    "/contact",
    "/portal",
  ];
  if (
    pathname &&
    PUBLIC_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`)
    )
  ) {
    return null;
  }

  const allowedBranches =
    isAuthenticated && user && !definition.allBranches
      ? branches.filter((b) => b.id === (user.branchId ?? branch.id))
      : branches;
  const branchSelectDisabled = isAuthenticated && !definition.allBranches;

  // Operational grouping puts the screens used most often (intake, orders) at
  // the top of each role's nav. Finance and management groups slide down into
  // less-frequent territory so the storefront workflow stays one tap away.
  const allNavItems: NavItem[] = [
    {
      href: "/",
      page: "dashboard",
      group: "ops",
      labelTh: t("nav.dashboard", "th"),
      labelEn: t("nav.dashboard", "en"),
      iconPath: ICON_PATHS.dashboard,
    },
    {
      href: "/intake",
      page: "intake",
      group: "ops",
      labelTh: "รับงานหน้าร้าน",
      labelEn: "Walk-in intake",
      iconPath: ICON_PATHS.intake,
    },
    {
      href: "/orders",
      page: "orders",
      group: "ops",
      labelTh: t("nav.orders", "th"),
      labelEn: t("nav.orders", "en"),
      iconPath: ICON_PATHS.orders,
    },
    {
      href: "/customers",
      page: "customers",
      group: "ops",
      labelTh: t("nav.customers", "th"),
      labelEn: t("nav.customers", "en"),
      iconPath: ICON_PATHS.customers,
    },
    {
      href: "/invoices",
      page: "invoices",
      group: "money",
      labelTh: t("nav.invoices", "th"),
      labelEn: t("nav.invoices", "en"),
      iconPath: ICON_PATHS.invoices,
    },
    {
      href: "/expenses",
      page: "expenses",
      group: "money",
      labelTh: "ค่าใช้จ่าย",
      labelEn: "Expenses",
      iconPath: ICON_PATHS.expenses,
    },
    {
      href: "/reports",
      page: "reports",
      group: "money",
      labelTh: "รายงาน",
      labelEn: "Reports",
      iconPath: ICON_PATHS.reports,
    },
    {
      href: "/pricing",
      page: "pricing",
      group: "admin",
      labelTh: "ตั้งราคา",
      labelEn: "Pricing",
      iconPath: ICON_PATHS.pricing,
    },
    {
      href: "/admin",
      page: "admin",
      group: "admin",
      labelTh: "ศูนย์จัดการระบบ",
      labelEn: "Admin centre",
      iconPath: ICON_PATHS.admin,
    },
    {
      href: "/admin/recovery",
      page: "recovery",
      group: "admin",
      labelTh: "กู้คืน / Retry",
      labelEn: "Recovery",
      iconPath: ICON_PATHS.recovery,
    },
    {
      href: "/admin/payroll",
      page: "admin",
      group: "admin",
      labelTh: "เงินเดือนช่าง",
      labelEn: "Payroll",
      iconPath: ICON_PATHS.expenses,
    },
    {
      href: "/admin/onboarding",
      page: "admin",
      group: "admin",
      labelTh: "เปิดสาขาใหม่",
      labelEn: "Onboarding",
      iconPath: ICON_PATHS.intake,
    },
  ];

  const navItems = allNavItems.filter((item) => canAccessPage(role, item.page));

  // Build grouped sections, preserving operational order within each group.
  const grouped: Record<NavGroup, NavItem[]> = {
    ops: navItems.filter((i) => i.group === "ops"),
    money: navItems.filter((i) => i.group === "money"),
    admin: navItems.filter((i) => i.group === "admin"),
  };

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      {/* Mobile Menu Button — 44 px touch target */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="md:hidden fixed top-3 left-3 z-40 w-11 h-11 flex items-center justify-center bg-green-700 text-white rounded-xl shadow-lg ring-1 ring-white/10 text-lg"
        aria-label="menu"
      >
        {isOpen ? "✕" : "☰"}
      </button>

      {/* Sidebar */}
      <aside
        className={`fixed md:relative h-screen w-72 md:w-64 bg-gradient-to-b from-green-800 via-green-800 to-green-950 text-white shadow-xl transition-transform duration-300 z-30 ${
          isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        } flex flex-col`}
      >
        {/* Brand */}
        <div className="px-5 py-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <BrandLogo size="md" variant="onColor" />
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.22em] text-yellow-300/90 font-semibold">
                CareU OPS
              </p>
              <h1 className="text-base font-bold leading-tight truncate">
                {branch.shortName}
              </h1>
            </div>
          </div>

          {/* Signed-in identity (only in strict auth mode) */}
          {isAuthenticated && user && (
            <div className="mt-4 rounded-lg bg-green-950/40 border border-white/10 p-2.5 text-xs">
              <p className="text-[10px] uppercase tracking-widest text-white/60">
                {language === "th" ? "เข้าระบบในชื่อ" : "Signed in as"}
              </p>
              <p className="font-semibold text-white truncate">{user.name}</p>
              <p className="text-[10px] text-yellow-200">
                {language === "th"
                  ? definition.labelTh
                  : definition.labelEn}
              </p>
              <button
                onClick={() => void signOut()}
                className="mt-2 w-full rounded bg-white/10 hover:bg-white/20 text-white text-[11px] font-semibold py-2"
              >
                {language === "th" ? "ออกจากระบบ" : "Sign out"}
              </button>
            </div>
          )}

          {/* Branch selector */}
          <div className="mt-4">
            <label className="block text-[10px] uppercase tracking-widest text-white/60 mb-1.5">
              {language === "th" ? "สาขา" : "Branch"}
            </label>
            <select
              value={branch.id}
              onChange={(e) => setBranchId(e.target.value)}
              disabled={branchSelectDisabled}
              className="w-full rounded-lg bg-green-950/50 text-white text-sm py-2.5 px-3 border border-white/15 focus:outline-none focus:ring-2 focus:ring-yellow-300 disabled:opacity-70 disabled:cursor-not-allowed"
              aria-label={language === "th" ? "เลือกสาขา" : "Select branch"}
            >
              {allowedBranches.map((b) => (
                <option key={b.id} value={b.id} className="text-gray-800">
                  {b.shortLabel}
                </option>
              ))}
            </select>
            {branchSelectDisabled && (
              <p className="mt-1 text-[10px] text-white/60">
                {language === "th"
                  ? "บทบาทนี้ถูกล็อกที่สาขาของคุณ"
                  : "Locked to your assigned branch"}
              </p>
            )}
          </div>

          {/* Role selector — preview mode only (no real session) */}
          {isPreview && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-[10px] uppercase tracking-widest text-white/60">
                  {language === "th" ? "บทบาท" : "Role"}
                </label>
                <span className="px-1.5 py-0.5 rounded bg-yellow-300/20 text-yellow-200 text-[9px] uppercase tracking-widest font-semibold">
                  {language === "th" ? "พรีวิว" : "Preview"}
                </span>
              </div>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="w-full rounded-lg bg-green-950/50 text-white text-sm py-2.5 px-3 border border-white/15 focus:outline-none focus:ring-2 focus:ring-yellow-300"
                aria-label={language === "th" ? "เลือกบทบาท" : "Select role"}
              >
                {roles.map((r) => (
                  <option key={r.role} value={r.role} className="text-gray-800">
                    {language === "th" ? r.labelTh : r.labelEn}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[10px] text-white/60 leading-tight">
                {language === "th"
                  ? definition.allBranches
                    ? "เห็นข้อมูลทุกสาขา"
                    : "เห็นข้อมูลเฉพาะสาขาที่เลือก"
                  : definition.allBranches
                  ? "Sees all branches"
                  : "Scoped to current branch"}
              </p>
            </div>
          )}
        </div>

        {/* Navigation — grouped operationally for fast access */}
        <nav className="px-3 py-3 space-y-4 flex-1 overflow-y-auto">
          {(Object.keys(grouped) as NavGroup[]).map((group) => {
            const items = grouped[group];
            if (items.length === 0) return null;
            return (
              <div key={group} className="space-y-0.5">
                {/* Show group label only when more than one group is visible. */}
                {Object.values(grouped).filter((g) => g.length > 0).length >
                  1 && (
                  <p className="px-3 text-[10px] uppercase tracking-[0.22em] text-white/40 font-semibold mb-1">
                    {language === "th"
                      ? GROUP_LABELS[group].th
                      : GROUP_LABELS[group].en}
                  </p>
                )}
                {items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setIsOpen(false)}
                    className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors border-l-4 min-h-[44px] ${
                      isActive(item.href)
                        ? "bg-white/15 border-yellow-300 font-semibold"
                        : "border-transparent hover:bg-white/10"
                    }`}
                  >
                    <Icon d={item.iconPath} />
                    <span className="text-sm">
                      {language === "th" ? item.labelTh : item.labelEn}
                    </span>
                  </Link>
                ))}
              </div>
            );
          })}
        </nav>

        {/* Language Selector */}
        <div className="p-4 border-t border-white/10">
          <p className="text-[10px] uppercase tracking-widest text-white/60 mb-2">
            {language === "th" ? "ภาษา" : "Language"}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setLanguage("th")}
              className={`flex-1 py-2 rounded text-xs font-semibold transition ${
                language === "th"
                  ? "bg-yellow-300 text-green-900"
                  : "bg-white/10 hover:bg-white/20"
              }`}
            >
              ไทย
            </button>
            <button
              onClick={() => setLanguage("en")}
              className={`flex-1 py-2 rounded text-xs font-semibold transition ${
                language === "en"
                  ? "bg-yellow-300 text-green-900"
                  : "bg-white/10 hover:bg-white/20"
              }`}
            >
              EN
            </button>
          </div>
        </div>
      </aside>

      {/* Overlay for mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 md:hidden z-20"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
};

export default Sidebar;
