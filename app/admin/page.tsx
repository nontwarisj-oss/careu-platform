"use client";

import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { useLanguage } from "@/lib/languageContext";
import { useRole } from "@/lib/roleContext";
import { canManageStaff } from "@/lib/permissions";

type AdminCard = {
  href: string;
  titleTh: string;
  titleEn: string;
  descTh: string;
  descEn: string;
  iconPath: string;
  /** When false the card renders as a "coming soon" placeholder. */
  enabled: boolean;
};

const CARDS: AdminCard[] = [
  {
    href: "/admin/staff",
    titleTh: "จัดการพนักงาน",
    titleEn: "Manage staff",
    descTh:
      "เปลี่ยนบทบาท ย้ายสาขา เปิด/ปิดการใช้งาน และตั้งค่าโปรไฟล์ช่างซ่อม",
    descEn:
      "Change roles, move branches, activate/deactivate, configure technician profiles.",
    iconPath:
      "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
    enabled: true,
  },
  {
    href: "/pricing",
    titleTh: "แคตตาล็อกราคา",
    titleEn: "Pricing catalog",
    descTh: "เพิ่ม/แก้ไขบริการ ราคา หมวด และซิงค์ไป Google Sheet",
    descEn: "Add/edit services, prices, categories, sync to Google Sheet.",
    iconPath:
      "M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z",
    enabled: true,
  },
  {
    href: "/admin/recovery",
    titleTh: "ระบบกู้คืน Sync / LINE",
    titleEn: "Recovery & retries",
    descTh:
      "ดู sync_failures + LINE message log ลองส่งซ้ำ และสร้างใบเสร็จใหม่ — Owner / HQ / Branch Manager",
    descEn:
      "Review sync_failures + LINE message log, retry sends, rebuild receipts.",
    iconPath:
      "M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8c-.45-.83-.7-1.79-.7-2.8 0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z",
    enabled: true,
  },
  {
    href: "/admin/customer-line",
    titleTh: "ผูกลูกค้ากับ LINE",
    titleEn: "Customer ↔ LINE linker",
    descTh:
      "จัดการ customer_line_links ที่ยังไม่จับคู่ลูกค้า — สำคัญสำหรับการส่งข้อความให้ลูกค้าที่ถูกคน",
    descEn:
      "Pair captured LINE followers with real customers — required for accurate notifications.",
    iconPath:
      "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
    enabled: true,
  },
  {
    href: "/admin/payroll",
    titleTh: "เงินเดือนช่าง (Payroll)",
    titleEn: "Technician payroll",
    descTh:
      "ดูประมาณการรายเดือน · ปรับ bonus / deduction · finalize → ทำเครื่องหมายจ่ายแล้ว",
    descEn:
      "Monthly preview · adjust bonus / deduction · finalize → mark paid.",
    iconPath:
      "M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1H6.32c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z",
    enabled: true,
  },
];

export default function AdminLandingPage() {
  return (
    <RouteGuard page="admin">
      <AdminLandingInner />
    </RouteGuard>
  );
}

function AdminLandingInner() {
  const { language } = useLanguage();
  const { role } = useRole();
  const hasStaffPower = canManageStaff(role);

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-6 flex flex-col gap-2 border-l-4 border-yellow-400 pl-4">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
          CareU OPS
        </p>
        <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
          {language === "th" ? "ศูนย์จัดการระบบ" : "Admin centre"}
        </h1>
        <p className="text-sm text-gray-600">
          {language === "th"
            ? "เฉพาะ Owner / HQ Admin — จัดการพนักงาน ราคา และระบบสำรอง"
            : "Owner / HQ Admin only — staff, pricing, and recovery"}
        </p>
      </div>

      {!hasStaffPower && (
        <div className="mb-4 rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          {language === "th"
            ? "บัญชีของคุณยังไม่มีสิทธิ์จัดการระบบ — ติดต่อ Owner เพื่อขอเปิดสิทธิ์"
            : "Your account does not have admin power yet — ask an Owner to promote it."}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((card) => {
          const body = (
            <div
              className={`h-full rounded-2xl border bg-white p-5 shadow-sm transition flex flex-col gap-3 ${
                card.enabled
                  ? "border-green-100 hover:border-green-300 hover:shadow-md"
                  : "border-gray-100 opacity-60"
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="inline-flex w-10 h-10 items-center justify-center rounded-xl bg-green-50 text-green-700">
                  <svg
                    viewBox="0 0 24 24"
                    className="w-5 h-5"
                    fill="currentColor"
                    aria-hidden
                  >
                    <path d={card.iconPath} />
                  </svg>
                </span>
                <h2 className="text-base font-bold text-gray-900">
                  {language === "th" ? card.titleTh : card.titleEn}
                </h2>
              </div>
              <p className="text-xs text-gray-600 leading-relaxed">
                {language === "th" ? card.descTh : card.descEn}
              </p>
              <span className="text-[11px] font-semibold uppercase tracking-widest text-green-700">
                {card.enabled
                  ? language === "th"
                    ? "เปิดใช้งาน →"
                    : "Open →"
                  : language === "th"
                  ? "เร็ว ๆ นี้"
                  : "Coming soon"}
              </span>
            </div>
          );
          if (!card.enabled || !hasStaffPower) {
            return (
              <div key={card.href} aria-disabled>
                {body}
              </div>
            );
          }
          return (
            <Link key={card.href} href={card.href}>
              {body}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
