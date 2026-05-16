// Service editorial content — the SEO copy behind /services/[slug].
//
// This is published, customer-facing editorial content (process,
// turnaround, FAQ, price guidance) — NOT mock data and NOT a price
// source of truth. Live per-item prices stay in service_prices; this
// file is the marketing narrative the business has approved.
//
// Adding a service page = add an entry here. The slug is the URL.
// Categories align with lib/pricing.ts SERVICE_CATEGORIES.
//
// Server-and-client safe — pure data.

export type ServiceFaq = { q: string; a: string };

export type ServiceContent = {
  /** URL slug — /services/<slug>. */
  slug: string;
  titleTh: string;
  titleEn: string;
  /** SERVICE_CATEGORIES code. */
  category: "alteration" | "repair" | "leather" | "luggage" | "drycleaning" | "special";
  /** One-line summary for cards + meta description. */
  summary: string;
  /** Customer-facing price guidance, e.g. "80–150". Not a quote. */
  priceRangeThb: string;
  /** Typical turnaround, customer-facing. */
  turnaround: string;
  /** How the job is done — 3-5 short steps. */
  processSteps: string[];
  faqs: ServiceFaq[];
};

export const SERVICE_CONTENT: ServiceContent[] = [
  {
    slug: "jeans-hemming",
    titleTh: "ตัดขากางเกงยีนส์",
    titleEn: "Jeans Hemming",
    category: "alteration",
    summary:
      "ตัดสั้น–เก็บชายกางเกงยีนส์ให้พอดีตัว เก็บริมแบบเดิมของโรงงานได้",
    priceRangeThb: "80–200",
    turnaround: "ภายใน 1–2 วัน",
    processSteps: [
      "วัดความยาวที่ต้องการกับช่าง หรือแนบกางเกงตัวอย่าง",
      "ช่างเลาะชายเดิมและกะระยะให้พอดี",
      "เย็บเก็บชาย — เลือกเก็บริมแบบโรงงานได้ (ค่าบริการเพิ่ม)",
      "รีดและตรวจความเรียบร้อยก่อนส่งมอบ",
    ],
    faqs: [
      {
        q: "เก็บริมแบบเดิมของกางเกงได้ไหม?",
        a: "ได้ครับ — เราเก็บริมแบบ original hem ให้เหมือนของโรงงาน มีค่าบริการเพิ่มเล็กน้อย",
      },
      {
        q: "ต้องนำกางเกงมาลองที่ร้านไหม?",
        a: "แนะนำให้นำมาลองเพื่อวัดความยาวที่พอดี แต่ถ้าทราบความยาวแน่นอนแล้วแจ้งช่างได้เลย",
      },
      {
        q: "ใช้เวลานานไหม?",
        a: "ปกติ 1–2 วัน หากเร่งด่วนแจ้งช่างเพื่อประเมินค่าบริการด่วน",
      },
    ],
  },
  {
    slug: "zipper-replacement",
    titleTh: "เปลี่ยนซิป",
    titleEn: "Zipper Replacement",
    category: "repair",
    summary:
      "เปลี่ยนซิปกางเกง กระโปรง เสื้อแจ็คเก็ต กระเป๋า — ซิปเสีย รูดไม่ขึ้น",
    priceRangeThb: "120–400",
    turnaround: "ภายใน 1–3 วัน",
    processSteps: [
      "ช่างตรวจชนิดและขนาดซิปที่ต้องใช้",
      "เลาะซิปเดิมออกอย่างระมัดระวังไม่ให้ผ้าเสียหาย",
      "ติดซิปใหม่ให้ตรงแนวและรูดลื่น",
      "ตรวจการใช้งานก่อนส่งมอบ",
    ],
    faqs: [
      {
        q: "เปลี่ยนซิปกระเป๋าหนังได้ไหม?",
        a: "ได้ครับ — งานหนังมีค่าบริการตามความยากของชิ้นงาน ช่างจะประเมินหน้างาน",
      },
      {
        q: "ราคาขึ้นกับอะไร?",
        a: "ขึ้นกับชนิดซิป (ซิปโลหะ/พลาสติก), ความยาว และชนิดผ้า",
      },
    ],
  },
  {
    slug: "suit-alteration",
    titleTh: "แก้สูท",
    titleEn: "Suit Alteration",
    category: "alteration",
    summary:
      "แก้เอว แก้ไหล่ เก็บทรงสูทและกางเกงสูทให้เข้ารูป โดยช่างผู้ชำนาญ",
    priceRangeThb: "200–800",
    turnaround: "ภายใน 3–5 วัน",
    processSteps: [
      "ลองสูทกับช่างเพื่อทำเครื่องหมายจุดที่ต้องแก้",
      "ช่างประเมินว่าทรงเดิมแก้ได้มากน้อยเพียงใด",
      "เลาะ–เย็บปรับทรงทีละส่วน (เอว/ไหล่/แขน/ขา)",
      "ลองซ้ำเพื่อยืนยันทรงก่อนเก็บงานละเอียด",
    ],
    faqs: [
      {
        q: "แก้สูทให้เล็กลงได้กี่ไซซ์?",
        a: "โดยทั่วไปแก้ได้ 1–2 ไซซ์ ขึ้นกับเนื้อผ้าและตะเข็บเดิม ช่างจะประเมินตอนลอง",
      },
      {
        q: "ต้องลองกี่ครั้ง?",
        a: "ปกติ 2 ครั้ง — ครั้งแรกทำเครื่องหมาย ครั้งที่สองยืนยันทรง",
      },
    ],
  },
  {
    slug: "dress-adjustment",
    titleTh: "แก้ชุดเดรส",
    titleEn: "Dress Adjustment",
    category: "alteration",
    summary:
      "เก็บเอว ปรับความยาว แก้สายเดรสและชุดราตรีให้เข้ารูปสวยงาม",
    priceRangeThb: "150–600",
    turnaround: "ภายใน 2–4 วัน",
    processSteps: [
      "ลองชุดกับช่างเพื่อกำหนดจุดที่ต้องปรับ",
      "ช่างวางแผนการแก้โดยคงดีไซน์เดิมไว้",
      "เย็บปรับทรง — เก็บเอว/ความยาว/สาย",
      "ลองซ้ำและเก็บรายละเอียดก่อนส่งมอบ",
    ],
    faqs: [
      {
        q: "แก้ชุดราตรีผ้าบางได้ไหม?",
        a: "ได้ครับ — ผ้าบางหรือผ้าลูกไม้ต้องใช้ความละเอียด มีค่าบริการตามความยาก",
      },
      {
        q: "นำชุดที่ซื้อจากที่อื่นมาแก้ได้ไหม?",
        a: "ได้ทุกชุดครับ ไม่จำเป็นต้องซื้อจากเรา",
      },
    ],
  },
];

export function getServiceContent(slug: string): ServiceContent | null {
  return SERVICE_CONTENT.find((s) => s.slug === slug) ?? null;
}

export function allServiceSlugs(): string[] {
  return SERVICE_CONTENT.map((s) => s.slug);
}
