// Metadata holder for /quote — Phase 27C.
//
// quote/page.tsx is a client component, so it cannot export `metadata`.
// This thin server layout supplies the title, description, and canonical
// URL; it renders children unchanged.

import type { Metadata } from "next";
import { absoluteUrl, canonical } from "@/lib/publicSeo";

export const metadata: Metadata = {
  title: "ขอใบเสนอราคา",
  description:
    "ขอใบเสนอราคางานซ่อม–ดัดแปลงออนไลน์ฟรี — เลือกบริการ แนบรูป เลือกสาขา แล้วทางร้านติดต่อกลับ",
  alternates: canonical("/quote"),
  openGraph: {
    title: "ขอใบเสนอราคา · Care U",
    description: "ขอใบเสนอราคางานซ่อม–ดัดแปลงออนไลน์ฟรี",
    type: "website",
    url: absoluteUrl("/quote"),
  },
};

export default function QuoteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
