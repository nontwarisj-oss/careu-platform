"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/lib/languageContext";
import { t, Language } from "@/lib/translations";

const Sidebar: React.FC = () => {
  const pathname = usePathname();
  const { language, setLanguage } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);

  const navItems = [
    { href: "/", label: t("nav.dashboard", language), icon: "📊" },
    { href: "/customers", label: t("nav.customers", language), icon: "👥" },
    { href: "/orders", label: t("nav.orders", language), icon: "🔧" },
    { href: "/invoices", label: t("nav.invoices", language), icon: "📄" },
  ];

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <>
      {/* Mobile Menu Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="md:hidden fixed top-4 left-4 z-40 p-2 bg-blue-600 text-white rounded-lg"
      >
        {isOpen ? "✕" : "☰"}
      </button>

      {/* Sidebar */}
      <aside
        className={`fixed md:relative h-screen w-64 bg-gradient-to-b from-blue-600 to-blue-800 text-white transition-transform duration-300 z-30 ${
          isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="p-6">
          <h1 className="text-2xl font-bold">CareU</h1>
          <p className="text-blue-100 text-sm mt-1">ระบบจัดการร้านซ่อม</p>
        </div>

        {/* Navigation */}
        <nav className="px-3 py-6 space-y-2">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setIsOpen(false)}
              className={`block px-4 py-3 rounded-lg transition-colors ${
                isActive(item.href)
                  ? "bg-blue-400 font-semibold"
                  : "hover:bg-blue-500"
              }`}
            >
              <span className="mr-3">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Language Selector */}
        <div className="absolute bottom-8 left-0 right-0 px-6">
          <div className="bg-blue-500 rounded-lg p-3">
            <p className="text-xs font-semibold mb-2 opacity-75">
              {language === "th" ? "ภาษา" : "Language"}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setLanguage("th")}
                className={`flex-1 py-1 px-2 rounded text-xs font-medium transition ${
                  language === "th"
                    ? "bg-white text-blue-600"
                    : "bg-blue-400 text-white hover:bg-blue-300"
                }`}
              >
                ไทย
              </button>
              <button
                onClick={() => setLanguage("en")}
                className={`flex-1 py-1 px-2 rounded text-xs font-medium transition ${
                  language === "en"
                    ? "bg-white text-blue-600"
                    : "bg-blue-400 text-white hover:bg-blue-300"
                }`}
              >
                EN
              </button>
            </div>
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
