import type { Metadata } from "next";
import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { defaultBrandTheme } from "@/lib/publicTheme";

export const metadata: Metadata = {
  title: "สาขาของเรา",
  description:
    "รายชื่อสาขา Care U + Ezy Repair ที่เปิดให้บริการ — ดูเวลา ที่อยู่ และบริการที่รองรับของแต่ละสาขา",
};

type BranchRow = {
  id: string;
  code: string;
  short_label: string | null;
  short_name: string | null;
  name: string;
  brand: string | null;
  tagline: string | null;
  address: string | null;
  phone: string | null;
  type: string | null;
};

async function loadBranches(): Promise<BranchRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const { data } = await admin
    .from("branches")
    .select(
      "id, code, short_label, short_name, name, brand, tagline, address, phone, type"
    )
    .eq("is_active", true)
    .order("code", { ascending: true });
  return (data ?? []) as BranchRow[];
}

export default async function BranchesIndexPage() {
  const branches = await loadBranches();
  const theme = defaultBrandTheme();
  return (
    <div>
      <section
        className={`bg-gradient-to-r ${theme.accentClass} text-white`}
      >
        <div className="max-w-6xl mx-auto px-4 py-10">
          <h1 className="text-3xl sm:text-4xl font-extrabold">สาขาของเรา</h1>
          <p className="mt-2 text-sm opacity-90">
            เลือกสาขาที่สะดวก — ทุกสาขาให้บริการมาตรฐานเดียวกัน
          </p>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-4 py-8">
        {branches.length === 0 ? (
          <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
            ยังไม่มีสาขาเปิดให้บริการ — กรุณาลองอีกครั้ง
          </div>
        ) : (
          <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {branches.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/branches/${b.code}`}
                  className="block h-full rounded-2xl border border-gray-200 bg-white p-5 hover:border-green-300 hover:shadow-md transition"
                >
                  <p className="text-[10px] uppercase tracking-widest text-green-700 font-semibold">
                    {b.brand?.toUpperCase() ?? "BRANCH"}
                  </p>
                  <h2 className="mt-1 text-lg font-bold text-gray-900">
                    {b.short_label ?? b.short_name ?? b.name}
                  </h2>
                  {b.address && (
                    <p className="mt-1 text-sm text-gray-600">{b.address}</p>
                  )}
                  {b.tagline && (
                    <p className="mt-2 text-xs text-gray-500 italic">
                      “{b.tagline}”
                    </p>
                  )}
                  <p className="mt-3 text-sm font-semibold text-green-700">
                    ดูสาขานี้ →
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
