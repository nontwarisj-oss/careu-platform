import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import { AuthHealthBanner } from "@/components/AuthHealthBanner";
import { LanguageProvider } from "@/lib/languageContext";
import { BranchProvider } from "@/lib/branchContext";
import { RoleProvider } from "@/lib/roleContext";
import { AuthProvider } from "@/lib/authContext";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CareU Dashboard",
  description: "ระบบจัดการร้านซ่อมผ้าและชุดทำความสะอาด",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="th"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-gray-100">
        <LanguageProvider>
          <RoleProvider>
            <BranchProvider>
              <AuthProvider>
                <AuthHealthBanner />
                <div className="flex min-h-screen">
                  <Sidebar />
                  <main className="flex-1 md:ml-0">{children}</main>
                </div>
              </AuthProvider>
            </BranchProvider>
          </RoleProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
