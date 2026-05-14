import type { Metadata } from "next";
import Link from "next/link";
import { defaultBrandTheme } from "@/lib/publicTheme";

export const metadata: Metadata = {
  title: "หน้าแรก",
  description:
    "Care U OPS — ร้านซ่อมผ้า ดัดแปลง ซักรีด และซ่อมรองเท้า / กระเป๋า รองรับหลายสาขาในกรุงเทพฯ. ติดตามงานออนไลน์ ขอใบเสนอราคาผ่านเว็บไซต์.",
  openGraph: {
    title: "Care U OPS",
    description: "ร้านซ่อมเสื้อผ้า / รองเท้า / กระเป๋า — ติดตามงานออนไลน์ได้",
  },
};

export default function PublicHomePage() {
  const theme = defaultBrandTheme();
  return (
    <div>
      <section
        className={`bg-gradient-to-r ${theme.accentClass} text-white`}
      >
        <div className="max-w-6xl mx-auto px-4 py-12 sm:py-16">
          <p className="text-xs uppercase tracking-[0.25em] font-semibold opacity-90">
            CARE U OPS
          </p>
          <h1 className="mt-3 text-3xl sm:text-5xl font-extrabold leading-tight">
            ดูแลเสื้อผ้า ซ่อมรองเท้า กระเป๋า
            <br className="hidden sm:block" /> ครบในที่เดียว
          </h1>
          <p className="mt-3 max-w-xl text-sm sm:text-base opacity-90">
            {theme.tagline} — เลือกสาขาที่ใกล้คุณ ติดตามสถานะงานได้ทันที
            หรือกดขอใบเสนอราคาออนไลน์
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/quote"
              className="rounded-xl bg-white text-green-800 px-5 py-3 text-sm font-semibold shadow-sm hover:bg-green-50"
            >
              ขอใบเสนอราคา
            </Link>
            <Link
              href="/track"
              className="rounded-xl bg-white/15 backdrop-blur border border-white/30 text-white px-5 py-3 text-sm font-semibold hover:bg-white/25"
            >
              ติดตามงานของฉัน
            </Link>
            <Link
              href="/branches"
              className="rounded-xl bg-white/15 backdrop-blur border border-white/30 text-white px-5 py-3 text-sm font-semibold hover:bg-white/25"
            >
              ดูสาขาทั้งหมด
            </Link>
          </div>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-4 py-10 sm:py-14">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <FeatureCard
            title="ติดตามงานออนไลน์"
            body="ใส่ Job ID + เบอร์โทร เพื่อดูสถานะงานล่าสุด — รู้ว่าพร้อมรับเมื่อใด"
            href="/track"
            cta="เปิดหน้าติดตาม"
          />
          <FeatureCard
            title="ขอใบเสนอราคา"
            body="เลือกบริการ ใส่รายละเอียดงาน แนบรูป — ทางร้านจะติดต่อกลับ"
            href="/quote"
            cta="ส่งคำขอ"
          />
          <FeatureCard
            title="ดูสาขาทั้งหมด"
            body="เลือกสาขาที่สะดวก ดูเวลาเปิด-ปิด เบอร์ติดต่อ บริการที่รองรับ"
            href="/branches"
            cta="ดูสาขา"
          />
          <FeatureCard
            title="บริการทั้งหมด"
            body="ตั้งแต่ดัดแปลงเสื้อผ้า ซิป งานปัก ไปจนถึงซ่อมรองเท้า / กระเป๋า"
            href="/services"
            cta="ดูบริการ"
          />
          <FeatureCard
            title="เกี่ยวกับเรา"
            body="ทีมงาน Care U ดูแลเสื้อผ้าคุณด้วยใจ ทุกสาขามาตรฐานเดียวกัน"
            href="/about"
            cta="อ่านต่อ"
          />
          <FeatureCard
            title="ติดต่อ"
            body="ส่งข้อความ ขอข้อมูล หรือสอบถามฝ่ายบริการลูกค้า"
            href="/contact"
            cta="ติดต่อเรา"
          />
        </div>
      </section>
    </div>
  );
}

function FeatureCard({
  title,
  body,
  href,
  cta,
}: {
  title: string;
  body: string;
  href: string;
  cta: string;
}) {
  return (
    <Link
      href={href}
      className="block rounded-2xl border border-gray-200 bg-white p-5 hover:border-green-300 hover:shadow-md transition"
    >
      <h2 className="text-lg font-bold text-gray-900">{title}</h2>
      <p className="mt-2 text-sm text-gray-600">{body}</p>
      <p className="mt-3 text-sm font-semibold text-green-700">{cta} →</p>
    </Link>
  );
}
