"use client";

import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { WorkerHealthBanner } from "@/components/WorkerHealthBanner";
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
  {
    href: "/admin/onboarding",
    titleTh: "เปิดสาขาใหม่ / Onboarding",
    titleEn: "Branch onboarding",
    descTh:
      "เพิ่มสาขาใหม่ในระบบ — สาขาจะถูกตั้งเป็น \"ปิดใช้งาน\" จนกว่าจะเปิดเอง",
    descEn:
      "Add a new branch to the system — new branches start inactive by default.",
    iconPath:
      "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
    enabled: true,
  },
  {
    href: "/admin/dispatch",
    titleTh: "Dispatch monitor",
    titleEn: "Dispatch monitor",
    descTh:
      "คิวข้อความลูกค้า (SMS / LINE) — ดูความล้มเหลว · รันรอบ dispatch ด้วยตนเอง — Owner / HQ",
    descEn:
      "Customer notification queue (SMS / LINE) — review failures, run dispatch ticks — Owner / HQ.",
    iconPath:
      "M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z",
    enabled: true,
  },
  {
    href: "/admin/crm/audiences",
    titleTh: "CRM Audiences",
    titleEn: "CRM audiences",
    descTh:
      "สร้าง segment + ประมาณการ audience — ยังไม่ส่งจริง — Owner / HQ / Branch Manager",
    descEn:
      "Build segments + estimate audience size — broadcast send is not enabled.",
    iconPath:
      "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3z",
    enabled: true,
  },
  {
    href: "/admin/crm/broadcasts",
    titleTh: "CRM Broadcasts (draft)",
    titleEn: "CRM broadcasts",
    descTh:
      "draft broadcast — ทดลองข้อความ + audience ก่อนส่งจริง — ยังไม่มี mass-send — Owner / HQ / Branch Manager",
    descEn:
      "Broadcast drafts — try messages + audiences before sending. Mass-send not yet enabled.",
    iconPath:
      "M21 11.5a.5.5 0 0 0-.5-.5h-2.93l1.04-1.04a.502.502 0 0 0 0-.71l-.71-.71a.502.502 0 0 0-.71 0L15 10.79V3.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v9l-3.5-3.5a.5.5 0 0 0-.71 0l-.71.71a.5.5 0 0 0 0 .71L12.79 14H3.5a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h13l4.5-4.5z",
    enabled: true,
  },
  {
    href: "/admin/settings/communications",
    titleTh: "Comms settings (per-branch)",
    titleEn: "Communications settings",
    descTh:
      "เปิด/ปิดช่อง · quiet hours · caps · cross-branch — ตั้งระดับ global หรือ override ต่อสาขา — Owner / HQ",
    descEn:
      "Channels · quiet hours · caps · cross-branch — global or per-branch overrides.",
    iconPath:
      "M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65c-.04-.24-.24-.42-.49-.42h-4c-.24 0-.45.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.04.24.25.42.49.42h4c.24 0 .45-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65z",
    enabled: true,
  },
  {
    href: "/admin/system/workers",
    titleTh: "Worker telemetry",
    titleEn: "Worker telemetry",
    descTh:
      "ดู cron · queue · stuck jobs · alerts · self-heal — Owner / HQ",
    descEn:
      "Cron heartbeats + queue depth + alerts + self-heal.",
    iconPath:
      "M19 8h-1V3H6v5H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zM8 5h8v3H8V5zm8 14H8v-4h8v4zm2-4v-2H6v2H4v-4c0-.55.45-1 1-1h14c.55 0 1 .45 1 1v4h-2z",
    enabled: true,
  },
  {
    href: "/admin/crm/engagement",
    titleTh: "Engagement intelligence",
    titleEn: "Engagement intelligence",
    descTh:
      "lifecycle breakdown · retention trend · churn risk · trigger summary — Owner / HQ / Branch Manager",
    descEn:
      "Lifecycle, retention, churn, and trigger-summary dashboard.",
    iconPath:
      "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
    enabled: true,
  },
  {
    href: "/admin/communications/templates",
    titleTh: "Message templates",
    titleEn: "Message templates",
    descTh:
      "เทมเพลตข้อความ + version history + test send — Owner / HQ",
    descEn: "Message templates + versioned history + test send.",
    iconPath:
      "M19 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h11v12zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z",
    enabled: true,
  },
  {
    href: "/admin/crm/triggers",
    titleTh: "Trigger explainability",
    titleEn: "Trigger explainability",
    descTh:
      "เห็นเหตุผลของทุก retention trigger — ทำไมยิง / ทำไม skip — Owner / HQ / Branch Manager",
    descEn: "See why every retention trigger fired or was skipped.",
    iconPath:
      "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-6h2v6zm0-8h-2V7h2v4z",
    enabled: true,
  },
  {
    href: "/admin/settings/triggers",
    titleTh: "Branch trigger overrides",
    titleEn: "Branch trigger overrides",
    descTh:
      "ตั้งค่า dormant / at-risk / quiet hours ต่อสาขา — fall back to HQ defaults",
    descEn:
      "Per-branch dormant / at-risk / quiet-hour thresholds with HQ fallback.",
    iconPath:
      "M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65c-.04-.24-.24-.42-.49-.42h-4c-.24 0-.45.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.04.24.25.42.49.42h4c.24 0 .45-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65z",
    enabled: true,
  },
  {
    href: "/admin/system/guardrails",
    titleTh: "Engagement guardrails",
    titleEn: "Engagement guardrails",
    descTh:
      "Emergency stop + daily caps + dry-run requirement — Owner / HQ",
    descEn:
      "Owner-managed safety layer with emergency stop, daily caps, dry-run requirement.",
    iconPath:
      "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z",
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

      {hasStaffPower && (
        <div className="mb-4">
          <WorkerHealthBanner />
        </div>
      )}

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
