"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/lib/languageContext";
import { useBranch } from "@/lib/branchContext";
import { t } from "@/lib/translations";
import { BrandLogo } from "@/components/BrandLogo";

interface NavItem {
  href: string;
  label: string;
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
};

const Icon = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    className="w-5 h-5"
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
  const [isOpen, setIsOpen] = useState(false);

  const navItems: NavItem[] = [
    { href: "/", label: t("nav.dashboard", language), iconPath: ICON_PATHS.dashboard },
    {
      href: "/intake",
      label: language === "th" ? "รับงานหน้าร้าน" : "Walk-in intake",
      iconPath: ICON_PATHS.intake,
    },
    { href: "/customers", label: t("nav.customers", language), iconPath: ICON_PATHS.customers },
    { href: "/orders", label: t("nav.orders", language), iconPath: ICON_PATHS.orders },
    { href: "/invoices", label: t("nav.invoices", language), iconPath: ICON_PATHS.invoices },
  ];

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      {/* Mobile Menu Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="md:hidden fixed top-4 left-4 z-40 p-2.5 bg-green-700 text-white rounded-lg shadow-lg ring-1 ring-white/10"
        aria-label="menu"
      >
        {isOpen ? "✕" : "☰"}
      </button>

      {/* Sidebar */}
      <aside
        className={`fixed md:relative h-screen w-64 bg-gradient-to-b from-green-800 via-green-800 to-green-950 text-white shadow-xl transition-transform duration-300 z-30 ${
          isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        } flex flex-col`}
      >
        {/* Brand */}
        <div className="px-5 py-6 border-b border-white/10">
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

          {/* Branch selector */}
          <div className="mt-4">
            <label className="block text-[10px] uppercase tracking-widest text-white/60 mb-1.5">
              {language === "th" ? "สาขา" : "Branch"}
            </label>
            <select
              value={branch.id}
              onChange={(e) => setBranchId(e.target.value)}
              className="w-full rounded-lg bg-green-950/50 text-white text-sm py-2 px-3 border border-white/15 focus:outline-none focus:ring-2 focus:ring-yellow-300"
              aria-label={language === "th" ? "เลือกสาขา" : "Select branch"}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id} className="text-gray-800">
                  {b.shortLabel}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Navigation */}
        <nav className="px-3 py-5 space-y-1 flex-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setIsOpen(false)}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors border-l-4 ${
                isActive(item.href)
                  ? "bg-white/15 border-yellow-300 font-semibold"
                  : "border-transparent hover:bg-white/10"
              }`}
            >
              <Icon d={item.iconPath} />
              <span className="text-sm">{item.label}</span>
            </Link>
          ))}
        </nav>

        {/* Language Selector */}
        <div className="p-5 border-t border-white/10">
          <p className="text-[10px] uppercase tracking-widest text-white/60 mb-2">
            {language === "th" ? "ภาษา" : "Language"}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setLanguage("th")}
              className={`flex-1 py-1.5 rounded text-xs font-semibold transition ${
                language === "th"
                  ? "bg-yellow-300 text-green-900"
                  : "bg-white/10 hover:bg-white/20"
              }`}
            >
              ไทย
            </button>
            <button
              onClick={() => setLanguage("en")}
              className={`flex-1 py-1.5 rounded text-xs font-semibold transition ${
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
