// /branches/[branchCode] — branch detail page.
//
// Phase 27B maturity: operating hours, a Google-Maps CTA (derived
// from the address — no map_url column needed), a LINE CTA, a
// supported-services grid, an optional promo banner, and
// LocalBusiness JSON-LD for local SEO.
//
// New columns operating_hours + promo_banner are nullable — the page
// degrades gracefully when a branch has not filled them in.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { themeForBranch, type BranchTheme } from "@/lib/publicTheme";
import { SERVICE_CONTENT } from "@/lib/serviceContent";
import { computeBranchStatus } from "@/lib/branchPublicStatus";

type BranchRow = {
  id: string;
  code: string;
  short_label: string | null;
  short_name: string | null;
  receipt_name: string | null;
  name: string;
  brand: string | null;
  tagline: string | null;
  address: string | null;
  phone: string | null;
  logo_path: string | null;
  accent_class: string | null;
  type: string | null;
  is_active: boolean;
  operating_hours: Record<string, string> | null;
  promo_banner: string | null;
  manual_status: "open" | "closed" | null;
  holiday_dates: string[] | null;
  map_url: string | null;
  line_url: string | null;
  hero_image_path: string | null;
};

const DAY_ORDER: Array<{ key: string; label: string }> = [
  { key: "mon", label: "จันทร์" },
  { key: "tue", label: "อังคาร" },
  { key: "wed", label: "พุธ" },
  { key: "thu", label: "พฤหัสบดี" },
  { key: "fri", label: "ศุกร์" },
  { key: "sat", label: "เสาร์" },
  { key: "sun", label: "อาทิตย์" },
];

const LINE_URL = process.env.NEXT_PUBLIC_LINE_OA_URL ?? "/contact";

async function loadBranch(code: string): Promise<BranchRow | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data } = await admin
    .from("branches")
    .select(
      "id, code, short_label, short_name, receipt_name, name, brand, tagline, address, phone, logo_path, accent_class, type, is_active, operating_hours, promo_banner, manual_status, holiday_dates, map_url, line_url, hero_image_path"
    )
    .eq("code", code)
    .eq("is_active", true)
    .maybeSingle();
  return (data as BranchRow | null) ?? null;
}

function rowToTheme(row: BranchRow): BranchTheme {
  return {
    branchCode: row.code,
    shortLabel: row.short_label ?? row.short_name ?? row.name,
    shortName: row.short_name ?? row.name,
    receiptName: row.receipt_name ?? row.name,
    tagline: row.tagline,
    address: row.address,
    phone: row.phone,
    logoPath: row.logo_path ?? "/logos/c24-careu.svg",
    accentClass: row.accent_class ?? "from-green-700 to-emerald-600",
    brand: row.brand === "ezy" ? "ezy" : "careu",
  };
}

function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    address
  )}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ branchCode: string }>;
}): Promise<Metadata> {
  const { branchCode } = await params;
  const branch = await loadBranch(branchCode);
  if (!branch) return { title: "ไม่พบสาขา" };
  const title = branch.short_label ?? branch.name;
  const description =
    branch.tagline ??
    `${title}${branch.address ? ` — ${branch.address}` : ""}`.trim();
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
  };
}

export default async function BranchDetailPage({
  params,
}: {
  params: Promise<{ branchCode: string }>;
}) {
  const { branchCode } = await params;
  const branch = await loadBranch(branchCode);
  if (!branch) notFound();
  const theme = themeForBranch(rowToTheme(branch));
  const hours =
    branch.operating_hours && typeof branch.operating_hours === "object"
      ? branch.operating_hours
      : null;

  // Phase 27D — dynamic open/closed + per-branch links.
  const status = computeBranchStatus({
    manualStatus: branch.manual_status,
    operatingHours: hours,
    holidayDates: branch.holiday_dates,
  });
  const lineHref = branch.line_url ?? LINE_URL;
  const mapHref = branch.map_url
    ? branch.map_url
    : branch.address
      ? mapsUrl(branch.address)
      : null;

  // LocalBusiness structured data for local SEO.
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: branch.name,
    ...(branch.address ? { address: branch.address } : {}),
    ...(branch.phone && branch.phone !== "N/A"
      ? { telephone: branch.phone }
      : {}),
  };

  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <section
        className={`relative bg-gradient-to-r ${theme.accentClass} text-white`}
      >
        {branch.hero_image_path && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={branch.hero_image_path}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-cover opacity-30"
            />
            <div className="absolute inset-0 bg-black/20" />
          </>
        )}
        <div className="relative max-w-6xl mx-auto px-4 py-10">
          <p className="text-[10px] uppercase tracking-[0.22em] font-semibold opacity-90">
            {theme.brandLabel}
          </p>
          <h1 className="mt-2 text-3xl sm:text-4xl font-extrabold">
            {branch.short_label ?? branch.name}
          </h1>
          {branch.tagline && (
            <p className="mt-2 text-sm sm:text-base opacity-90 italic">
              “{branch.tagline}”
            </p>
          )}
          <span
            className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${
              status.status === "open"
                ? "bg-white text-green-800"
                : status.status === "closed"
                  ? "bg-red-900/40 text-white border border-white/40"
                  : "bg-white/20 text-white border border-white/30"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                status.status === "open"
                  ? "bg-green-600"
                  : status.status === "closed"
                    ? "bg-red-400"
                    : "bg-gray-300"
              }`}
            />
            {status.label}
          </span>
        </div>
      </section>

      {branch.promo_banner && (
        <div className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-6xl mx-auto px-4 py-2.5 text-sm text-amber-900 font-medium">
            🎁 {branch.promo_banner}
          </div>
        </div>
      )}

      <section className="max-w-6xl mx-auto px-4 py-8 grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-4">
          {/* Branch info */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-lg font-bold text-gray-900">ข้อมูลสาขา</h2>
            <dl className="mt-3 grid sm:grid-cols-2 gap-3 text-sm">
              <Field label="ชื่อเต็ม" value={branch.name} />
              <Field
                label="ประเภทธุรกิจ"
                value={
                  branch.type === "ezy_repair"
                    ? "Ezy Repair (รองเท้า / กระเป๋า)"
                    : branch.type === "care_u"
                      ? "Care U (ดัดแปลง / ซักรีด)"
                      : "บริการครบวงจร"
                }
              />
              <Field label="ที่อยู่" value={branch.address ?? "—"} />
              <Field
                label="เบอร์ติดต่อ"
                value={
                  branch.phone && branch.phone !== "N/A" ? branch.phone : "—"
                }
              />
            </dl>
          </div>

          {/* Operating hours */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-lg font-bold text-gray-900">เวลาทำการ</h2>
            {hours ? (
              <table className="mt-3 w-full text-sm">
                <tbody>
                  {DAY_ORDER.map((d) => (
                    <tr
                      key={d.key}
                      className="border-b border-gray-50 last:border-0"
                    >
                      <td className="py-1.5 text-gray-600">{d.label}</td>
                      <td className="py-1.5 text-right font-medium text-gray-900">
                        {hours[d.key] ?? "ปิด"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-2 text-sm text-gray-500">
                กรุณาติดต่อสาขาทางโทรศัพท์หรือ LINE เพื่อสอบถามเวลาทำการ
              </p>
            )}
            {hours?.note && (
              <p className="mt-2 text-[11px] text-gray-500">{hours.note}</p>
            )}
          </div>

          {/* Supported services */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-lg font-bold text-gray-900">บริการที่รองรับ</h2>
            <div className="mt-3 grid sm:grid-cols-2 gap-2">
              {SERVICE_CONTENT.map((s) => (
                <Link
                  key={s.slug}
                  href={`/services/${s.slug}`}
                  className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-800 hover:border-green-300 hover:bg-white"
                >
                  {s.titleTh}
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* CTA rail */}
        <aside className="space-y-3">
          <Link
            href={`/quote?branch=${encodeURIComponent(branch.code)}`}
            className={`block w-full rounded-xl px-5 py-3 text-center font-semibold ${theme.primaryButtonClass}`}
          >
            ขอใบเสนอราคาที่สาขานี้
          </Link>
          {mapHref && (
            <a
              href={mapHref}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full rounded-xl border border-gray-200 bg-white px-5 py-3 text-center font-semibold text-gray-700 hover:bg-gray-50"
            >
              📍 เปิดใน Google Maps
            </a>
          )}
          <a
            href={lineHref}
            className="block w-full rounded-xl border border-green-300 bg-white px-5 py-3 text-center font-semibold text-green-700 hover:bg-green-50"
          >
            💬 ติดต่อทาง LINE
          </a>
          <Link
            href="/track"
            className="block w-full rounded-xl border border-gray-200 bg-white px-5 py-3 text-center font-semibold text-gray-700 hover:bg-gray-50"
          >
            ติดตามงานของฉัน
          </Link>
        </aside>
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-widest text-gray-500">
        {label}
      </dt>
      <dd className="mt-0.5 text-gray-900">{value}</dd>
    </div>
  );
}
