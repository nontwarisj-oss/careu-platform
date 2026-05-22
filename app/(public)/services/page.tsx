import type { Metadata } from "next";
import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { defaultBrandTheme } from "@/lib/publicTheme";
import { SERVICE_CONTENT } from "@/lib/serviceContent";
import { canonical } from "@/lib/publicSeo";

// W-B Pricing Source Alignment:
// The public catalogue reads the SAME master the order/convert flow uses —
// public.service_price_master, the table the owner maintains via the Google
// Sheet "Service_Prices" tab. The legacy public.service_prices table is no
// longer read here, so the website and the real order price can never drift.

export const metadata: Metadata = {
  title: "บริการของเรา",
  description:
    "บริการครบครันจาก Care U + Ezy Repair — ดัดแปลงเสื้อผ้า, ซิป, ซักรีด, ซ่อมรองเท้า / กระเป๋า, งานปัก",
  alternates: canonical("/services"),
};

type CatalogRow = {
  service_code: string;
  service_name_th: string;
  category_th: string;
  quote_mode: string | null;
  base_price: number | string | null;
  min_price: number | string | null;
  max_price: number | string | null;
  customer_note_th: string | null;
};

async function loadServices(): Promise<CatalogRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const { data } = await admin
    .from("service_price_master")
    .select(
      "service_code, service_name_th, category_th, quote_mode, base_price, min_price, max_price, customer_note_th, sort_order, active"
    )
    .eq("active", true)
    .order("category_th", { ascending: true })
    .order("sort_order", { ascending: true })
    .limit(300);
  return (data as CatalogRow[] | null) ?? [];
}

function toNum(v: number | string | null): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Customer-facing price label, derived from the master's quote mode. */
function priceLabel(s: CatalogRow): { text: string; estimate: boolean } {
  const mode = (s.quote_mode ?? "").toUpperCase();
  const base = toNum(s.base_price);
  const min = toNum(s.min_price);
  const max = toNum(s.max_price);
  if (mode === "GUIDED_QUOTE" && min !== null && max !== null) {
    return min === max
      ? { text: `฿${min.toFixed(0)}`, estimate: false }
      : { text: `฿${min.toFixed(0)}–${max.toFixed(0)}`, estimate: false };
  }
  if (base !== null) {
    return { text: `เริ่มต้น ฿${base.toFixed(0)}`, estimate: false };
  }
  return { text: "ราคาประเมินหน้าร้าน", estimate: true };
}

export default async function ServicesPage() {
  const services = await loadServices();
  const theme = defaultBrandTheme();
  const byCategory = new Map<string, CatalogRow[]>();
  for (const s of services) {
    const cat = s.category_th?.trim() || "อื่น ๆ";
    const list = byCategory.get(cat) ?? [];
    list.push(s);
    byCategory.set(cat, list);
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
        {/* Featured services — link to the SEO detail pages. Price is shown
            on the catalogue below (live, from the master) — the card keeps
            only the turnaround so no stale price can appear here. */}
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
                  {s.turnaround}
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
          [...byCategory.entries()].map(([category, items]) => (
            <div
              key={category}
              className="rounded-2xl border border-gray-200 bg-white p-5"
            >
              <h2 className="text-lg font-bold text-gray-900">{category}</h2>
              <ul className="mt-3 grid sm:grid-cols-2 gap-2">
                {items.map((s) => {
                  const price = priceLabel(s);
                  return (
                    <li
                      key={s.service_code}
                      className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2"
                    >
                      <p className="font-semibold text-gray-900 text-sm">
                        {s.service_name_th}
                      </p>
                      {s.customer_note_th && (
                        <p className="text-xs text-gray-600 mt-0.5 truncate">
                          {s.customer_note_th}
                        </p>
                      )}
                      <p className="mt-1 text-xs">
                        <span
                          className={
                            price.estimate
                              ? "text-yellow-700 font-semibold"
                              : "text-green-700 font-semibold"
                          }
                        >
                          {price.text}
                        </span>
                      </p>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
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
