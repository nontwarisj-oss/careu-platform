import type { Metadata } from "next";
import Link from "next/link";
import { SITE_URL } from "@/lib/publicSeo";

// The public website lives under this layout — no OPS sidebar, no
// admin chrome. The root layout (app/layout.tsx) still mounts the
// LanguageProvider / RoleProvider / BranchProvider / AuthProvider
// because some shared components (like the language switcher in the
// public footer) read from those contexts. AuthProvider's strict-mode
// `/login` redirect is bypassed for these paths via PUBLIC_PREFIXES in
// lib/authContext.tsx.
//
// The OPS Sidebar component itself short-circuits when pathname starts
// with a public prefix, so visitors don't see it.

// metadataBase lets every public page emit absolute canonical + OG
// URLs (and resolve the generated opengraph-image routes) from a
// relative path. Set once here; inherited by all (public) pages.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Care U — บริการดูแลเสื้อผ้า / ซ่อมรองเท้า / กระเป๋า",
    template: "%s · Care U",
  },
  description:
    "Care U OPS — ร้านซ่อมผ้า ดัดแปลง ซักรีด และซ่อมรองเท้า/กระเป๋า. ส่งงานหน้าร้านหรือทาง LINE OA. หลายสาขาในเขตกรุงเทพฯ.",
  openGraph: {
    type: "website",
    siteName: "Care U OPS",
    locale: "th_TH",
    url: SITE_URL,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-white text-gray-900">
      {/* Keyboard users land here first — jump straight to content. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:rounded-lg focus:bg-green-700 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        ข้ามไปยังเนื้อหา
      </a>
      <PublicHeader />
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <PublicFooter />
    </div>
  );
}

function PublicHeader() {
  return (
    <header className="border-b border-gray-200 bg-white sticky top-0 z-30">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
        <Link
          href="/website"
          className="flex items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-600 focus-visible:ring-offset-2"
          aria-label="Care U home"
        >
          <span className="inline-block w-8 h-8 rounded-lg bg-gradient-to-r from-green-700 to-emerald-600" />
          <span className="font-bold text-gray-900 text-lg">Care U</span>
        </Link>
        <nav
          aria-label="เมนูหลัก"
          className="flex items-center gap-1 text-sm overflow-x-auto"
        >
          <NavLink href="/services">บริการ</NavLink>
          <NavLink href="/branches">สาขา</NavLink>
          <NavLink href="/track">ติดตามงาน</NavLink>
          <NavLink href="/quote">ขอใบเสนอราคา</NavLink>
          <NavLink href="/portal">พอร์ทัล</NavLink>
          <NavLink href="/about">เกี่ยวกับเรา</NavLink>
          <NavLink href="/contact">ติดต่อ</NavLink>
        </nav>
      </div>
    </header>
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
      className="shrink-0 px-3 py-2 rounded-full text-gray-700 hover:bg-green-50 hover:text-green-800 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-600"
    >
      {children}
    </Link>
  );
}

function PublicFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-gray-200 bg-gray-50 mt-12">
      <div className="max-w-6xl mx-auto px-4 py-6 text-sm text-gray-600 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <p className="font-semibold text-gray-800">Care U OPS</p>
          <p className="text-xs mt-1">
            ระบบจัดการร้านซ่อมผ้าและซ่อมรองเท้า/กระเป๋า — รองรับหลายสาขา
          </p>
        </div>
        <div className="text-xs space-y-1">
          <p>
            <Link href="/about" className="hover:text-green-800">
              เกี่ยวกับเรา
            </Link>
            {" · "}
            <Link href="/contact" className="hover:text-green-800">
              ติดต่อ
            </Link>
            {" · "}
            <Link href="/track" className="hover:text-green-800">
              ติดตามงาน
            </Link>
          </p>
          <p className="text-gray-500">© {year} Care U OPS</p>
        </div>
      </div>
    </footer>
  );
}
