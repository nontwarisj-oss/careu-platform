// /services/[slug] — dynamic SEO service pages.
//
// Phase 27B. Editorial content from lib/serviceContent.ts (a static,
// business-approved map) — process, turnaround, price guidance, FAQ.
// Each page emits FAQPage + Service JSON-LD for SEO.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { defaultBrandTheme } from "@/lib/publicTheme";
import {
  SERVICE_CONTENT,
  getServiceContent,
  allServiceSlugs,
} from "@/lib/serviceContent";

export function generateStaticParams(): Array<{ slug: string }> {
  return allServiceSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const svc = getServiceContent(slug);
  if (!svc) return { title: "ไม่พบบริการ" };
  const title = `${svc.titleTh} (${svc.titleEn})`;
  return {
    title,
    description: svc.summary,
    openGraph: { title, description: svc.summary, type: "article" },
  };
}

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const svc = getServiceContent(slug);
  if (!svc) notFound();
  const theme = defaultBrandTheme();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: svc.titleEn,
    serviceType: svc.titleTh,
    description: svc.summary,
    mainEntityOfPage: {
      "@type": "FAQPage",
      mainEntity: svc.faqs.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  };

  // Related services — same category, excluding the current one.
  const related = SERVICE_CONTENT.filter(
    (s) => s.category === svc.category && s.slug !== svc.slug
  ).slice(0, 3);

  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <section className={`bg-gradient-to-r ${theme.accentClass} text-white`}>
        <div className="max-w-3xl mx-auto px-4 py-10">
          <div className="flex items-center gap-2 text-xs opacity-90">
            <Link href="/services" className="hover:underline">
              บริการ
            </Link>
            <span>/</span>
            <span>{svc.titleTh}</span>
          </div>
          <h1 className="mt-2 text-3xl sm:text-4xl font-extrabold">
            {svc.titleTh}
          </h1>
          <p className="mt-2 text-sm sm:text-base opacity-90">{svc.summary}</p>
        </div>
      </section>

      <section className="max-w-3xl mx-auto px-4 py-8 space-y-5">
        {/* Quick facts */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <p className="text-xs uppercase tracking-widest text-gray-500">
              ราคาเริ่มต้น
            </p>
            <p className="mt-1 text-xl font-extrabold text-green-700">
              ฿{svc.priceRangeThb}
            </p>
            <p className="text-[11px] text-gray-500">
              ราคาจริงประเมินตามชิ้นงาน
            </p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <p className="text-xs uppercase tracking-widest text-gray-500">
              ระยะเวลา
            </p>
            <p className="mt-1 text-xl font-extrabold text-gray-900">
              {svc.turnaround}
            </p>
          </div>
        </div>

        {/* Process */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-lg font-bold text-gray-900">ขั้นตอนการทำงาน</h2>
          <ol className="mt-3 space-y-3">
            {svc.processSteps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-green-700 text-white text-xs font-bold">
                  {i + 1}
                </span>
                <span className="text-sm text-gray-700">{step}</span>
              </li>
            ))}
          </ol>
        </div>

        {/* FAQ */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-lg font-bold text-gray-900">คำถามที่พบบ่อย</h2>
          <div className="mt-3 space-y-2">
            {svc.faqs.map((f) => (
              <details
                key={f.q}
                className="group rounded-xl border border-gray-100 bg-gray-50 p-3"
              >
                <summary className="cursor-pointer font-semibold text-gray-900 text-sm list-none flex items-center justify-between">
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

        {/* CTA */}
        <div className="rounded-2xl bg-green-50 border border-green-200 p-5 text-center">
          <p className="font-bold text-gray-900">
            อยากได้ราคาที่แน่นอนสำหรับ{svc.titleTh}?
          </p>
          <p className="mt-1 text-sm text-gray-600">
            ส่งรูปและรายละเอียดงาน — ทางร้านประเมินให้ฟรี
          </p>
          <Link
            href={`/quote?service=${svc.category}`}
            className={`mt-3 inline-block rounded-xl px-6 py-3 text-sm font-semibold ${theme.primaryButtonClass}`}
          >
            ขอใบเสนอราคา
          </Link>
        </div>

        {/* Related */}
        {related.length > 0 && (
          <div>
            <h2 className="text-base font-bold text-gray-900">บริการที่เกี่ยวข้อง</h2>
            <div className="mt-3 grid sm:grid-cols-3 gap-2">
              {related.map((r) => (
                <Link
                  key={r.slug}
                  href={`/services/${r.slug}`}
                  className="rounded-xl border border-gray-200 bg-white p-3 text-sm font-medium text-gray-800 hover:border-green-300"
                >
                  {r.titleTh}
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
