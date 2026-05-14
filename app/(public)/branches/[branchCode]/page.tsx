import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { themeForBranch, type BranchTheme } from "@/lib/publicTheme";

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
};

async function loadBranch(code: string): Promise<BranchRow | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data } = await admin
    .from("branches")
    .select(
      "id, code, short_label, short_name, receipt_name, name, brand, tagline, address, phone, logo_path, accent_class, type, is_active"
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
    branch.tagline ?? `${title} — ${branch.address ?? ""}`.trim();
  return {
    title,
    description,
    openGraph: { title, description },
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

  return (
    <div>
      <section
        className={`bg-gradient-to-r ${theme.accentClass} text-white`}
      >
        <div className="max-w-6xl mx-auto px-4 py-10">
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
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-4 py-8 grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-lg font-bold text-gray-900">ข้อมูลสาขา</h2>
            <dl className="mt-3 grid sm:grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-widest text-gray-500">
                  ชื่อเต็ม
                </dt>
                <dd className="mt-0.5 text-gray-900">{branch.name}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-widest text-gray-500">
                  ประเภทธุรกิจ
                </dt>
                <dd className="mt-0.5 text-gray-900">
                  {branch.type === "ezy_repair"
                    ? "Ezy Repair (รองเท้า / กระเป๋า)"
                    : branch.type === "care_u"
                    ? "Care U (ดัดแปลง / ซักรีด)"
                    : "Mixed"}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-widest text-gray-500">
                  ที่อยู่
                </dt>
                <dd className="mt-0.5 text-gray-900">
                  {branch.address ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-widest text-gray-500">
                  เบอร์ติดต่อ
                </dt>
                <dd className="mt-0.5 text-gray-900">
                  {branch.phone && branch.phone !== "N/A"
                    ? branch.phone
                    : "—"}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-5 text-sm text-gray-600">
            แผนที่และเวลาเปิด-ปิดจะอยู่ที่นี่เมื่อระบบ map ของสาขาพร้อมใช้งาน —
            ตอนนี้ติดต่อทางโทรศัพท์หรือ LINE ของสาขาได้เลย
          </div>
        </div>

        <aside className="space-y-3">
          <Link
            href={`/quote?branch=${encodeURIComponent(branch.code)}`}
            className={`block w-full rounded-xl px-5 py-3 text-center font-semibold ${theme.primaryButtonClass}`}
          >
            ขอใบเสนอราคาที่สาขานี้
          </Link>
          <Link
            href="/track"
            className="block w-full rounded-xl border border-green-300 bg-white px-5 py-3 text-center font-semibold text-green-700 hover:bg-green-50"
          >
            ติดตามงานของฉัน
          </Link>
          <Link
            href="/services"
            className="block w-full rounded-xl border border-gray-200 bg-white px-5 py-3 text-center font-semibold text-gray-700 hover:bg-gray-50"
          >
            ดูบริการทั้งหมด
          </Link>
        </aside>
      </section>
    </div>
  );
}
