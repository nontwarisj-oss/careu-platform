import type { Metadata } from "next";
import Link from "next/link";
import { defaultBrandTheme } from "@/lib/publicTheme";

export const metadata: Metadata = {
  title: "ติดต่อเรา",
  description:
    "ติดต่อ Care U OPS — สอบถามบริการ ขอใบเสนอราคา หรือติดตามงาน",
};

export default function ContactPage() {
  const theme = defaultBrandTheme();
  return (
    <div>
      <section className={`bg-gradient-to-r ${theme.accentClass} text-white`}>
        <div className="max-w-3xl mx-auto px-4 py-10">
          <h1 className="text-3xl sm:text-4xl font-extrabold">ติดต่อเรา</h1>
          <p className="mt-2 text-sm opacity-90">
            หลายช่องทาง — เลือกที่สะดวกที่สุดได้เลย
          </p>
        </div>
      </section>

      <section className="max-w-3xl mx-auto px-4 py-8 space-y-4 text-sm sm:text-base">
        <ContactBlock
          title="ขอใบเสนอราคาออนไลน์"
          body="กรอกฟอร์มสั้น ๆ ใส่ภาพ / รายละเอียดงาน — ทางร้านติดต่อกลับภายใน 1 วันทำการ"
          cta="ส่งคำขอ"
          href="/quote"
        />
        <ContactBlock
          title="ติดตามงานของคุณ"
          body="มี Job ID อยู่แล้ว? ใส่ Job ID + เบอร์โทรเพื่อเช็คสถานะ"
          cta="ติดตามงาน"
          href="/track"
        />
        <ContactBlock
          title="แวะที่สาขา"
          body="ดูที่อยู่ + เบอร์ของแต่ละสาขา — หรือเลือกที่ใกล้คุณที่สุด"
          cta="ดูสาขา"
          href="/branches"
        />

        <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-5 text-gray-600 text-sm">
          <p className="font-semibold text-gray-800">หมายเหตุ</p>
          <p className="mt-1">
            เฉพาะการสอบถามการดำเนินงานในระบบ OPS — กรุณาทักไลน์สาขาโดยตรง
            หรือใช้ฟอร์มขอใบเสนอราคาด้านบน
          </p>
        </div>
      </section>
    </div>
  );
}

function ContactBlock({
  title,
  body,
  cta,
  href,
}: {
  title: string;
  body: string;
  cta: string;
  href: string;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <h2 className="text-lg font-bold text-gray-900">{title}</h2>
      <p className="mt-1 text-sm text-gray-600">{body}</p>
      <Link
        href={href}
        className="mt-3 inline-block rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold"
      >
        {cta} →
      </Link>
    </div>
  );
}
