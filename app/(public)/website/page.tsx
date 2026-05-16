// Public homepage — Phase 27B maturity rebuild.
//
// Server component. Sections: hero · service categories · process
// flow · branch finder (live from `branches`) · FAQ (+ JSON-LD) ·
// LINE CTA. Mobile-first; no hardcoded branches — the finder reads
// the DB.

import type { Metadata } from "next";
import Link from "next/link";
import { defaultBrandTheme } from "@/lib/publicTheme";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { SERVICE_CONTENT } from "@/lib/serviceContent";
import { computeBranchStatus } from "@/lib/branchPublicStatus";
import { SITE_URL, absoluteUrl, canonical } from "@/lib/publicSeo";

export const metadata: Metadata = {
  title: "หน้าแรก",
  description:
    "Care U — ร้านดัดแปลงเสื้อผ้า ซ่อมซิป ซ่อมรองเท้าและกระเป๋า หลายสาขาในกรุงเทพฯ ติดตามงานออนไลน์และขอใบเสนอราคาผ่านเว็บได้ทันที",
  alternates: canonical("/website"),
  openGraph: {
    title: "Care U — ดูแลเสื้อผ้า ซ่อมรองเท้า กระเป๋า",
    description:
      "ร้านดัดแปลงเสื้อผ้า / ซ่อมรองเท้า / กระเป๋า — ขอใบเสนอราคาและติดตามงานออนไลน์",
    type: "website",
    url: absoluteUrl("/website"),
  },
};

// Static, business-approved FAQ — also emitted as FAQPage JSON-LD.
const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "ขอใบเสนอราคาต้องเสียค่าใช้จ่ายไหม?",
    a: "ไม่มีค่าใช้จ่าย — ส่งรายละเอียดงานและรูป ทางร้านจะประเมินและติดต่อกลับฟรี",
  },
  {
    q: "ใช้เวลาซ่อมนานเท่าไหร่?",
    a: "งานทั่วไปเสร็จภายใน 1–5 วันขึ้นกับประเภทงาน มีบริการด่วนสำหรับงานเร่ง",
  },
  {
    q: "ติดตามสถานะงานได้อย่างไร?",
    a: "ใช้ Job ID กับเบอร์โทรที่หน้า ‘ติดตามงาน’ หรือเข้าสู่ระบบพอร์ทัลลูกค้าเพื่อดูประวัติทั้งหมด",
  },
  {
    q: "นำเสื้อผ้าที่ซื้อจากที่อื่นมาแก้ได้ไหม?",
    a: "ได้ทุกชิ้น — ไม่จำเป็นต้องซื้อจากเรา",
  },
];

type BranchRow = {
  code: string;
  short_label: string | null;
  short_name: string | null;
  name: string;
  type: string | null;
  address: string | null;
  operating_hours: Record<string, string> | null;
  manual_status: "open" | "closed" | null;
  holiday_dates: string[] | null;
};

async function loadBranches(): Promise<BranchRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const { data } = await admin
    .from("branches")
    .select(
      "code, short_label, short_name, name, type, address, operating_hours, manual_status, holiday_dates"
    )
    .eq("is_active", true)
    .order("code", { ascending: true });
  return (data as BranchRow[] | null) ?? [];
}

const LINE_URL = process.env.NEXT_PUBLIC_LINE_OA_URL ?? "/contact";

export default async function PublicHomePage() {
  const theme = defaultBrandTheme();
  const branches = await loadBranches();

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQS.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  // Organization + WebSite identity — helps search engines build the
  // brand knowledge panel and treat /website as the site home.
  const siteJsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Care U",
      url: SITE_URL,
      description:
        "ร้านดัดแปลงเสื้อผ้า ซ่อมซิป ซ่อมรองเท้าและกระเป๋า หลายสาขาในกรุงเทพฯ",
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Care U",
      url: SITE_URL,
      inLanguage: "th-TH",
    },
  ];

  return (
    <div>
      {/* FAQ structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      {/* Organization + WebSite structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd) }}
      />

      {/* ---------- Hero ---------- */}
      <section className={`bg-gradient-to-r ${theme.accentClass} text-white`}>
        <div className="max-w-6xl mx-auto px-4 py-14 sm:py-20">
          <p className="text-xs uppercase tracking-[0.25em] font-semibold opacity-90">
            CARE U
          </p>
          <h1 className="mt-3 text-3xl sm:text-5xl font-extrabold leading-tight">
            ดูแลเสื้อผ้า ซ่อมรองเท้า กระเป๋า
            <br className="hidden sm:block" /> ครบ จบ ในที่เดียว
          </h1>
          <p className="mt-3 max-w-xl text-sm sm:text-base opacity-90">
            {theme.tagline} — เลือกสาขาที่ใกล้คุณ ขอใบเสนอราคาออนไลน์
            และติดตามสถานะงานได้ทุกขั้นตอน
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/quote"
              className="rounded-xl bg-white text-green-800 px-5 py-3 text-sm font-semibold shadow-sm hover:bg-green-50"
            >
              ขอใบเสนอราคาฟรี
            </Link>
            <Link
              href="/track"
              className="rounded-xl bg-white/15 backdrop-blur border border-white/30 text-white px-5 py-3 text-sm font-semibold hover:bg-white/25"
            >
              ติดตามงานของฉัน
            </Link>
          </div>
        </div>
      </section>

      {/* ---------- Service categories ---------- */}
      <section className="max-w-6xl mx-auto px-4 py-10 sm:py-14">
        <SectionHead
          title="บริการของเรา"
          subtitle="งานซ่อม–ดัดแปลงครบทุกแบบ โดยช่างผู้ชำนาญ"
        />
        <div className="mt-5 grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {SERVICE_CONTENT.map((s) => (
            <Link
              key={s.slug}
              href={`/services/${s.slug}`}
              className="block rounded-2xl border border-gray-200 bg-white p-4 hover:border-green-300 hover:shadow-md transition"
            >
              <h3 className="font-bold text-gray-900">{s.titleTh}</h3>
              <p className="mt-1 text-xs text-gray-600 line-clamp-2">
                {s.summary}
              </p>
              <p className="mt-2 text-xs font-semibold text-green-700">
                เริ่ม ฿{s.priceRangeThb.split("–")[0]} · {s.turnaround}
              </p>
            </Link>
          ))}
        </div>
        <div className="mt-4">
          <Link
            href="/services"
            className="text-sm font-semibold text-green-700 hover:text-green-900"
          >
            ดูบริการทั้งหมด →
          </Link>
        </div>
      </section>

      {/* ---------- Process flow ---------- */}
      <section className="bg-gray-50 border-y border-gray-100">
        <div className="max-w-6xl mx-auto px-4 py-10 sm:py-14">
          <SectionHead
            title="ขั้นตอนง่าย ๆ 4 ขั้น"
            subtitle="ตั้งแต่ขอราคาจนรับงานคืน"
          />
          <ol className="mt-5 grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { n: 1, t: "ขอใบเสนอราคา", d: "ส่งรายละเอียดงาน + รูปผ่านเว็บ" },
              { n: 2, t: "ร้านติดต่อกลับ", d: "ยืนยันราคาและนัดส่งงาน" },
              { n: 3, t: "ช่างลงมือซ่อม", d: "ติดตามสถานะได้ทุกขั้นตอน" },
              { n: 4, t: "รับงานคืน", d: "แจ้งเตือนเมื่อพร้อมรับ" },
            ].map((step) => (
              <li
                key={step.n}
                className="rounded-2xl border border-gray-200 bg-white p-4"
              >
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-green-700 text-white text-sm font-bold">
                  {step.n}
                </span>
                <h3 className="mt-2 font-bold text-gray-900">{step.t}</h3>
                <p className="mt-0.5 text-xs text-gray-600">{step.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------- Branch finder ---------- */}
      <section className="max-w-6xl mx-auto px-4 py-10 sm:py-14">
        <SectionHead
          title="สาขาของเรา"
          subtitle="เลือกสาขาที่สะดวกที่สุดสำหรับคุณ"
        />
        {branches.length === 0 ? (
          <p className="mt-5 text-sm text-gray-500">
            ดูรายชื่อสาขาทั้งหมดได้ที่หน้า{" "}
            <Link href="/branches" className="text-green-700 underline">
              สาขา
            </Link>
          </p>
        ) : (
          <div className="mt-5 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {branches.map((b) => {
              const status = computeBranchStatus({
                manualStatus: b.manual_status,
                operatingHours: b.operating_hours,
                holidayDates: b.holiday_dates,
              });
              return (
                <Link
                  key={b.code}
                  href={`/branches/${b.code}`}
                  className="block rounded-2xl border border-gray-200 bg-white p-4 hover:border-green-300 hover:shadow-md transition"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-bold text-gray-900">
                      {b.short_label ?? b.short_name ?? b.name}
                    </h3>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        status.status === "open"
                          ? "bg-green-50 text-green-700 border border-green-200"
                          : status.status === "closed"
                            ? "bg-red-50 text-red-700 border border-red-200"
                            : "bg-gray-50 text-gray-500 border border-gray-200"
                      }`}
                    >
                      {status.label}
                    </span>
                  </div>
                  {b.address && (
                    <p className="mt-1 text-xs text-gray-600 line-clamp-2">
                      {b.address}
                    </p>
                  )}
                  <p className="mt-2 text-xs font-semibold text-green-700">
                    ดูข้อมูลสาขา →
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* ---------- FAQ ---------- */}
      <section className="bg-gray-50 border-y border-gray-100">
        <div className="max-w-3xl mx-auto px-4 py-10 sm:py-14">
          <SectionHead title="คำถามที่พบบ่อย" />
          <div className="mt-5 space-y-2">
            {FAQS.map((f) => (
              <details
                key={f.q}
                className="group rounded-2xl border border-gray-200 bg-white p-4"
              >
                <summary className="cursor-pointer font-semibold text-gray-900 list-none flex items-center justify-between">
                  {f.q}
                  <span className="text-green-700 group-open:rotate-45 transition-transform">
                    +
                  </span>
                </summary>
                <p className="mt-2 text-sm text-gray-600">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- LINE CTA ---------- */}
      <section className="max-w-6xl mx-auto px-4 py-12 text-center">
        <h2 className="text-2xl font-extrabold text-gray-900">
          พร้อมเริ่มงานของคุณแล้วหรือยัง?
        </h2>
        <p className="mt-2 text-sm text-gray-600">
          ขอใบเสนอราคาออนไลน์ หรือทักหาเราทาง LINE ได้เลย
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <Link
            href="/quote"
            className={`rounded-xl px-6 py-3 text-sm font-semibold ${theme.primaryButtonClass}`}
          >
            ขอใบเสนอราคา
          </Link>
          <a
            href={LINE_URL}
            className="rounded-xl border border-green-600 bg-white px-6 py-3 text-sm font-semibold text-green-700 hover:bg-green-50"
          >
            ติดต่อทาง LINE
          </a>
        </div>
      </section>
    </div>
  );
}

function SectionHead({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div>
      <h2 className="text-2xl sm:text-3xl font-extrabold text-gray-900">
        {title}
      </h2>
      {subtitle && <p className="mt-1 text-sm text-gray-600">{subtitle}</p>}
    </div>
  );
}
