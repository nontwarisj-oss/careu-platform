import type { Metadata } from "next";
import { defaultBrandTheme } from "@/lib/publicTheme";

export const metadata: Metadata = {
  title: "เกี่ยวกับเรา",
  description:
    "Care U OPS — ร้านซ่อมผ้า + ซ่อมรองเท้า / กระเป๋า บริการแบบมืออาชีพ. ทุกสาขามาตรฐานเดียวกัน ติดตามงานออนไลน์ได้",
};

export default function AboutPage() {
  const theme = defaultBrandTheme();
  return (
    <div>
      <section className={`bg-gradient-to-r ${theme.accentClass} text-white`}>
        <div className="max-w-3xl mx-auto px-4 py-10">
          <h1 className="text-3xl sm:text-4xl font-extrabold">เกี่ยวกับเรา</h1>
          <p className="mt-2 text-sm opacity-90">
            ทีม Care U + Ezy Repair — ดูแลเสื้อผ้าและของใช้คุณด้วยใจ
          </p>
        </div>
      </section>

      <section className="max-w-3xl mx-auto px-4 py-8 space-y-5 text-sm sm:text-base text-gray-800 leading-relaxed">
        <p>
          Care U เริ่มจากความตั้งใจที่จะทำร้านซ่อมผ้าที่ลูกค้าวางใจได้ —
          งานที่ได้กลับไปต้องดีเท่ากับร้านแบรนด์
          และต้องสะดวกเหมือนร้านในห้าง
        </p>
        <p>
          วันนี้เราขยายเป็นเครือข่ายหลายสาขา ครอบคลุมทั้ง
          งานดัดแปลงเสื้อผ้า ซ่อมรองเท้า กระเป๋า และซักรีด —
          แต่ละสาขาได้รับการดูแลจากทีมงานที่ผ่านการอบรมมาตรฐานเดียวกัน
        </p>
        <p>
          ด้านหลังร้าน เราทำงานบนระบบ OPS Platform ของเราเอง
          เพื่อให้ลูกค้าทุกคนได้รับบริการที่สม่ำเสมอ —
          ติดตามงานออนไลน์ได้ทันที ใบเสร็จย้อนหลังถูกเก็บไว้ในระบบ
          และทุกสาขาเห็นข้อมูลของตัวเองเท่านั้นเพื่อความเป็นส่วนตัวของลูกค้า
        </p>

        <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5">
          <h2 className="text-lg font-bold text-gray-900">บริการของเรา</h2>
          <ul className="mt-2 grid sm:grid-cols-2 gap-1 text-sm">
            <li>• ดัดแปลง / ซ่อมเสื้อผ้า</li>
            <li>• ซ่อมซิป / กระดุม / รอยขาด</li>
            <li>• ซักรีด / ซักแห้ง</li>
            <li>• ซ่อมรองเท้า / เปลี่ยนพื้น</li>
            <li>• ซ่อมกระเป๋า / กระเป๋าเดินทาง</li>
            <li>• งานปัก / สกรีน</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
