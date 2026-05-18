// Basic PWA / mobile web-app metadata. Next App Router serves this at
// /manifest.webmanifest and links it automatically — no service worker.
//
// Lets staff "Add to Home Screen" the mobile intake flow on a phone.

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Care U OPS",
    short_name: "Care U OPS",
    description: "ระบบจัดการร้านซ่อมผ้า Care U — รับงานหน้าร้านผ่านมือถือ",
    // The mobile shortcut should land staff straight on the capture flow.
    start_url: "/mobile-intake",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#15803d", // Care U green (Tailwind green-700)
    icons: [],
  };
}
