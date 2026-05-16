// Metadata holder for /track — Phase 27C.
//
// track/page.tsx is a client component, so it cannot export `metadata`.
// This thin server layout supplies the title, description, and canonical
// URL; it renders children unchanged.

import type { Metadata } from "next";
import { absoluteUrl, canonical } from "@/lib/publicSeo";

export const metadata: Metadata = {
  title: "ติดตามงาน",
  description:
    "ติดตามสถานะงานซ่อม–ดัดแปลงของคุณด้วย Job ID + เบอร์โทร — ดูสถานะ การชำระเงิน และกำหนดรับงาน",
  alternates: canonical("/track"),
  openGraph: {
    title: "ติดตามงาน · Care U",
    description: "ติดตามสถานะงานด้วย Job ID + เบอร์โทร",
    type: "website",
    url: absoluteUrl("/track"),
  },
};

export default function TrackLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
