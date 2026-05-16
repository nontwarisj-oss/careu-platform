import type { Metadata } from "next";
import Link from "next/link";
import { PortalNotificationsLink } from "@/components/PortalNotificationsLink";

export const metadata: Metadata = {
  title: {
    default: "พอร์ทัลลูกค้า",
    template: "%s · พอร์ทัลลูกค้า",
  },
  description:
    "พอร์ทัลลูกค้า Care U — เข้าระบบดูประวัติงาน อัปเดตข้อมูล และติดตามสถานะงานล่าสุด",
  robots: { index: false, follow: false },
};

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white sticky top-0 z-30">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <Link href="/portal" className="flex items-center gap-2">
            <span className="inline-block w-8 h-8 rounded-lg bg-gradient-to-r from-green-700 to-emerald-600" />
            <span className="font-bold text-gray-900">พอร์ทัลลูกค้า</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <NavLink href="/portal/orders">งานของฉัน</NavLink>
            <PortalNotificationsLink />
            <NavLink href="/portal/profile">โปรไฟล์</NavLink>
            <NavLink href="/website">เว็บหลัก</NavLink>
          </nav>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="shrink-0 px-3 py-2 rounded-full text-gray-700 hover:bg-green-50 hover:text-green-800 font-medium"
    >
      {children}
    </Link>
  );
}
