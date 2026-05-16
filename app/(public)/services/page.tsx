import type { Metadata } from "next";
import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { SERVICE_CATEGORIES } from "@/lib/pricing";
import { defaultBrandTheme } from "@/lib/publicTheme";
import { SERVICE_CONTENT } from "@/lib/serviceContent";

export const metadata: Metadata = {
  title: "บริการของเรา",
  description:
    "บริการครบครันจาก Care U + Ezy Repair — ดัดแปลงเสื้อผ้า, ซิป, ซักรีด, ซ่อมรองเท้า / กระเป๋า, งานปัก",
};

type CatalogRow = {
  service_code: string;
  display_name: string;
  description: string | null;
  category: string;
  business_type: string;
  base_price: number | string | null;
  pricing_type: string;
};

async function loadServices(): Promise<CatalogRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const { data } = await admin
    .from("service_prices")
    .select(
      "service_code, display_name, description, category, business_type, base_price, pricing_type, is_active, effective_to"
    )
    .eq("is_active", true)
    .order("category", { ascending: true })
    .order("sort_order", { ascending: true })
    .limit(200);
  return (data as CatalogRow[] | null) ?? [];
}

export default async function ServicesPage() {
  const services = await loadServices();
  const theme = defaultBrandTheme();
  const byCategory = new Map<string, CatalogRow[]>();
  for (const s of services) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s);
    byCategory.set(s.category, list);
  }
  return (
    <div>
      <section className={`bg-gradient-to-r ${theme.accentClass} text-white`}>
        <div className="max-w-6xl mx-auto px-4 py-10">
          <h1 className="text-3xl sm:text-4xl font-extrabold">บริการของเรา</h1>
          <p className="mt-2 text-sm opacity-90 max-w-xl">
            ราคาที่แสดงเป็นราคาเริ่มต้น — งานบางประเภทจะคำนวณตามชิ้นจริงเมื่อรับงาน
          </p>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-4 py-8 space-y-6">
        {/* Featured services — link to the SEO detail pages. */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-lg font-bold text-gray-900">บริการแนะนำ</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            ดูรายละเอียดขั้นตอน ระยะเวลา และคำถามที่พบบ่อย
          </p>
          <div className="mt-3 grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {SERVICE_CONTENT.map((s) => (
              <Link
                key={s.slug}
                href={`/services/${s.slug}`}
                className="rounded-xl border border-gray-100 bg-gray-50 p-3 hover:border-green-300 hover:bg-white transition"
              >
                <p className="font-semibold text-gray-900 text-sm">
                  {s.titleTh}
                </p>
                <p className="mt-0.5 text-xs text-green-700 font-semibold">
                  ฿{s.priceRangeThb} · {s.turnaround}
                </p>
              </Link>
            ))}
          </div>
        </div>

        {services.length === 0 ? (
          <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
            ยังไม่มีรายการบริการพร้อมแสดงในขณะนี้
          </div>
        ) : (
          SERVICE_CATEGORIES.map((cat) => {
            const items = byCategory.get(cat.code) ?? [];
            if (items.length === 0) return null;
            return (
              <div
                key={cat.code}
                className="rounded-2xl border border-gray-200 bg-white p-5"
              >
                <h2 className="text-lg font-bold text-gray-900">
                  {cat.labelTh}
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">{cat.labelEn}</p>
                <ul className="mt-3 grid sm:grid-cols-2 gap-2">
                  {items.map((s) => (
                    <li
                      key={s.service_code}
                      className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2"
                    >
                      <p className="font-semibold text-gray-900 text-sm">
                        {s.display_name}
                      </p>
                      {s.description && (
                        <p className="text-xs text-gray-600 mt-0.5 truncate">
                          {s.description}
                        </p>
                      )}
                      <p className="mt-1 text-xs">
                        {s.pricing_type === "estimate_required" ||
                        s.base_price === null ? (
                          <span className="text-yellow-700 font-semibold">
                            ราคาประเมินหน้าร้าน
                          </span>
                        ) : (
                          <span className="text-green-700 font-semibold">
                            เริ่มต้น ฿{Number(s.base_price).toFixed(0)}
                          </span>
                        )}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}

        <div className="rounded-2xl border border-green-200 bg-green-50 p-5 text-center">
          <p className="text-sm text-green-900">
            ไม่เจอบริการที่ต้องการ?{" "}
            <Link href="/quote" className="underline font-semibold">
              ส่งคำขอใบเสนอราคาได้เลย
            </Link>{" "}
            — ทางร้านจะติดต่อกลับ
          </p>
        </div>
      </section>
    </div>
  );
}
