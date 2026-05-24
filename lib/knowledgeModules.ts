// Phase C / L5 — AI Intake Knowledge Modules (7 service domains).
//
// Declarative ONLY. No DB, no fetch, no React, no model calls. Each
// module is a *definition* the Core Brain / Service Router reads — never
// a code branch. Adding service #8 = add one entry to KNOWLEDGE_MODULES
// and one key to ServiceDomain. Router, classify route, Guided Question
// Engine, and DB schema do NOT change (design doc §5.6).
//
// Per design (LINE-OA-Intake-Architecture.md §5.3–§5.4 +
// AI-INTAKE-DESIGN-23MAY2026.md §4):
//   - classificationHints  → consumed by lib/serviceRouter.ts to pick
//     the domain from customer text / image labels / voice transcript.
//   - requiredFields + requiredMedia → the Core Brain diffs them against
//     what the draft already has; the gap IS the missing-info checklist.
//   - guidedQuestions → L6 (Guided Question Engine) sends only the ones
//     whose `trigger` matches a still-missing field/media slot.
//
// F3 guard: everything here only ever *suggests*. A human confirms in
// /admin/intake-drafts before any price or order is created.

// ---------- Service domains ------------------------------------------------

export type ServiceDomain =
  | "clothing_repair"
  | "shoe_repair"
  | "luggage_repair"
  | "watch_battery"
  | "watch_repair"
  | "car_key_battery"
  | "ezy_other";

export const SERVICE_DOMAINS: ServiceDomain[] = [
  "clothing_repair",
  "shoe_repair",
  "luggage_repair",
  "watch_battery",
  "watch_repair",
  "car_key_battery",
  "ezy_other",
];

export function isServiceDomain(value: unknown): value is ServiceDomain {
  return (
    typeof value === "string" &&
    (SERVICE_DOMAINS as string[]).includes(value)
  );
}

// ---------- Declarative module shape --------------------------------------

export type FieldType = "text" | "number" | "choice" | "boolean";
export type MediaType = "image" | "video" | "audio";

export type ModuleCategory = { key: string; labelTh: string };
export type ModuleField = { key: string; labelTh: string; type: FieldType };
export type ModuleMedia = { key: string; labelTh: string; mediaType: MediaType };

/** Tokens the Router scores against. keywordsTh match customer text /
 *  voice transcript; imageLabels match the bot's vision labels. */
export type ClassificationHints = {
  keywordsTh: string[];
  imageLabels: string[];
};

/** A guided question the L6 engine may queue. `trigger` is the field or
 *  media key it targets — sent only while that slot is still empty. */
export type GuidedQuestion = {
  trigger: string;
  questionTh: string;
  fillsField?: string;
  fillsMedia?: string;
};

export type KnowledgeModule = {
  key: ServiceDomain;
  displayNameTh: string;
  categories: ModuleCategory[];
  requiredFields: ModuleField[];
  requiredMedia: ModuleMedia[];
  classificationHints: ClassificationHints;
  guidedQuestions: GuidedQuestion[];
};

// ---------- The 7 modules --------------------------------------------------

const CLOTHING_REPAIR: KnowledgeModule = {
  key: "clothing_repair",
  displayNameTh: "ตัดเย็บ / ซ่อมเสื้อผ้า (Care U)",
  categories: [
    { key: "hem", labelTh: "ตัดปลายขา / เก็บชาย" },
    { key: "hem_original", labelTh: "ตัดต่อปลายเดิม" },
    { key: "zipper_replace", labelTh: "เปลี่ยนซิป" },
    { key: "waist_adjust", labelTh: "ปรับเอว" },
    { key: "tear_repair", labelTh: "เย็บซ่อมรอยขาด" },
    { key: "patch", labelTh: "ปะผ้า" },
    { key: "lining_repair", labelTh: "ซ่อมผ้าซับใน" },
    { key: "button_repair", labelTh: "ติด / เปลี่ยนกระดุม" },
    { key: "general_alter", labelTh: "แก้ทรง / งานตัดเย็บอื่น" },
  ],
  requiredFields: [
    { key: "garment_type", labelTh: "ประเภทเสื้อผ้า", type: "text" },
    { key: "repair_intent", labelTh: "ต้องการแก้/ซ่อมอะไร", type: "text" },
    { key: "target_length", labelTh: "ความยาว/ขนาดที่ต้องการ", type: "text" },
  ],
  requiredMedia: [
    { key: "garment_full", labelTh: "รูปเต็มตัวของเสื้อผ้า", mediaType: "image" },
    { key: "repair_closeup", labelTh: "รูปใกล้จุดที่ต้องซ่อม", mediaType: "image" },
  ],
  classificationHints: {
    keywordsTh: [
      "เสื้อ", "เสื้อผ้า", "กางเกง", "ยีนส์", "กระโปรง", "เดรส", "ชุด",
      "สูท", "แจ็คเก็ต", "เสื้อโค้ท", "ตัดขา", "ตัดเย็บ", "เย็บ",
      "ชายขา", "ปลายขา", "เก็บชาย", "เข้าเอว", "ลดเอว", "ขยายเอว",
      "ปะผ้า", "ผ้าขาด", "ซับใน", "กระดุม", "แก้ทรง", "ตัดต่อปลาย",
    ],
    imageLabels: ["garment", "clothing", "pants", "jeans", "shirt", "dress", "skirt", "suit"],
  },
  guidedQuestions: [
    {
      trigger: "repair_closeup",
      questionTh: "รบกวนถ่ายรูปใกล้ ๆ ตรงจุดที่ต้องการซ่อม/แก้ให้หน่อยค่ะ",
      fillsMedia: "repair_closeup",
    },
    {
      trigger: "preserve_original_hem",
      questionTh: "ต้องการเก็บชายเดิม (ชายลุ่ย/ชายพับเดิม) ไว้ไหมคะ?",
      fillsField: "preserve_original_hem",
    },
    {
      trigger: "target_length",
      questionTh: "อยากได้ความยาวเท่าไหร่ หรือมีรอยพับที่ทำเครื่องหมายไว้ไหมคะ?",
      fillsField: "target_length",
    },
    {
      trigger: "leg_opening",
      questionTh: "ถ้าเป็นทรงขาเดฟ รบกวนแจ้งความกว้างปลายขาที่ต้องการด้วยค่ะ",
      fillsField: "leg_opening",
    },
    {
      trigger: "fabric_label",
      questionTh: "ขอรูปป้ายแบรนด์/เนื้อผ้าเพิ่มได้ไหมคะ (ช่วยประเมินงานแม่นขึ้น)",
      fillsMedia: "fabric_label",
    },
  ],
};

const SHOE_REPAIR: KnowledgeModule = {
  key: "shoe_repair",
  displayNameTh: "ซ่อมรองเท้า (Ezy Repair)",
  categories: [
    { key: "sole_repair", labelTh: "ซ่อม/ติดพื้นรองเท้า" },
    { key: "sole_replace", labelTh: "เปลี่ยนพื้นใหม่" },
    { key: "heel_repair", labelTh: "ซ่อมส้นรองเท้า" },
    { key: "stitch_repair", labelTh: "เย็บซ่อมหนัง/ผ้า" },
    { key: "color_restore", labelTh: "ทำสี/ฟื้นสภาพ" },
  ],
  requiredFields: [
    { key: "shoe_type", labelTh: "ประเภทรองเท้า", type: "text" },
    { key: "sole_condition", labelTh: "อาการของพื้นรองเท้า", type: "text" },
  ],
  requiredMedia: [
    { key: "sole_bottom", labelTh: "รูปพื้นรองเท้าด้านล่าง", mediaType: "image" },
    { key: "side_view", labelTh: "รูปด้านข้างรองเท้า", mediaType: "image" },
  ],
  classificationHints: {
    keywordsTh: [
      "รองเท้า", "พื้นรองเท้า", "ส้นรองเท้า", "ส้นสึก", "พื้นหลุด",
      "พื้นแตก", "สนีกเกอร์", "ผ้าใบ", "รองเท้าหนัง", "รองเท้าแตะ",
      "ติดพื้น", "เปลี่ยนพื้น",
    ],
    imageLabels: ["shoe", "sneaker", "sole", "boot", "sandal", "footwear"],
  },
  guidedQuestions: [
    {
      trigger: "sole_bottom",
      questionTh: "ขอรูปพื้นรองเท้าด้านล่างค่ะ",
      fillsMedia: "sole_bottom",
    },
    {
      trigger: "side_view",
      questionTh: "ขอรูปด้านข้างของรองเท้าด้วยค่ะ",
      fillsMedia: "side_view",
    },
    {
      trigger: "sole_condition",
      questionTh: "อาการของพื้นรองเท้าเป็นแบบไหนคะ — หลุด / แตก / ต้องเปลี่ยนพื้นใหม่?",
      fillsField: "sole_condition",
    },
  ],
};

const LUGGAGE_REPAIR: KnowledgeModule = {
  key: "luggage_repair",
  displayNameTh: "ซ่อมกระเป๋าเดินทาง (Ezy Repair)",
  categories: [
    { key: "wheel_replace", labelTh: "เปลี่ยน/ซ่อมล้อ" },
    { key: "handle_repair", labelTh: "ซ่อมมือจับ/คันชัก" },
    { key: "zipper_repair", labelTh: "ซ่อม/เปลี่ยนซิป" },
    { key: "shell_repair", labelTh: "ซ่อมตัวกระเป๋า" },
  ],
  requiredFields: [
    { key: "issue_type", labelTh: "ปัญหาหลักของกระเป๋า", type: "text" },
    { key: "broken_wheel_count", labelTh: "จำนวนล้อที่เสีย", type: "number" },
    { key: "brand_model", labelTh: "แบรนด์/รุ่นกระเป๋า", type: "text" },
  ],
  requiredMedia: [
    { key: "luggage_full", labelTh: "รูปกระเป๋าทั้งใบ", mediaType: "image" },
    { key: "issue_closeup", labelTh: "รูปใกล้จุดที่เสีย", mediaType: "image" },
  ],
  classificationHints: {
    keywordsTh: [
      "กระเป๋าเดินทาง", "กระเป๋าลาก", "ล้อกระเป๋า", "ล้อลาก", "คันชัก",
      "มือจับกระเป๋า", "ซิปกระเป๋า", "เป้", "กระเป๋าใบใหญ่", "ล้อหลุด",
    ],
    imageLabels: ["luggage", "suitcase", "trolley", "wheel"],
  },
  guidedQuestions: [
    {
      trigger: "broken_wheel_count",
      questionTh: "ล้อกระเป๋าเสียกี่ล้อคะ?",
      fillsField: "broken_wheel_count",
    },
    {
      trigger: "issue_closeup",
      questionTh: "ขอรูปใกล้ ๆ ของล้อ/จุดที่เสียค่ะ",
      fillsMedia: "issue_closeup",
    },
    {
      trigger: "brand_model",
      questionTh: "ทราบแบรนด์/รุ่นกระเป๋าไหมคะ (มีก็ช่วยได้มากค่ะ)",
      fillsField: "brand_model",
    },
    {
      trigger: "handle_zipper",
      questionTh: "ถ้ามือจับหรือซิปมีปัญหาด้วย รบกวนถ่ายรูปเพิ่มค่ะ",
      fillsMedia: "handle_zipper",
    },
  ],
};

const WATCH_BATTERY: KnowledgeModule = {
  key: "watch_battery",
  displayNameTh: "เปลี่ยนถ่านนาฬิกา (Ezy Repair)",
  categories: [
    { key: "battery_standard", labelTh: "เปลี่ยนถ่านทั่วไป" },
    { key: "battery_water_test", labelTh: "เปลี่ยนถ่าน + ทดสอบกันน้ำ" },
  ],
  requiredFields: [
    { key: "service_intent", labelTh: "ยืนยันว่าต้องการเปลี่ยนถ่าน", type: "choice" },
    { key: "water_resistance_test", labelTh: "ต้องการทดสอบกันน้ำไหม", type: "boolean" },
  ],
  requiredMedia: [
    { key: "watch_front", labelTh: "รูปนาฬิกาด้านหน้า", mediaType: "image" },
    { key: "watch_back", labelTh: "รูปนาฬิกาด้านหลัง", mediaType: "image" },
  ],
  classificationHints: {
    keywordsTh: [
      "เปลี่ยนถ่าน", "ถ่านนาฬิกา", "นาฬิกาตาย", "นาฬิกาหยุดเดิน",
      "ถ่านหมด", "นาฬิกาไม่เดิน", "ใส่ถ่าน",
    ],
    imageLabels: ["watch", "wristwatch"],
  },
  guidedQuestions: [
    {
      trigger: "watch_front",
      questionTh: "ขอรูปนาฬิกาด้านหน้าและด้านหลังค่ะ",
      fillsMedia: "watch_front",
    },
    {
      trigger: "service_intent",
      questionTh: "ต้องการ 'เปลี่ยนถ่าน' หรือ 'ซ่อมนาฬิกา' คะ?",
      fillsField: "service_intent",
    },
    {
      trigger: "water_resistance_test",
      questionTh: "ต้องการทดสอบกันน้ำหลังเปลี่ยนถ่านด้วยไหมคะ?",
      fillsField: "water_resistance_test",
    },
  ],
};

const WATCH_REPAIR: KnowledgeModule = {
  key: "watch_repair",
  displayNameTh: "ซ่อมนาฬิกา (Ezy Repair)",
  categories: [
    { key: "movement_repair", labelTh: "ซ่อมระบบกลไก/เครื่อง" },
    { key: "strap_replace", labelTh: "เปลี่ยน/ซ่อมสาย" },
    { key: "glass_replace", labelTh: "เปลี่ยนกระจกหน้าปัด" },
    { key: "hands_repair", labelTh: "ซ่อมเข็มนาฬิกา" },
  ],
  requiredFields: [
    { key: "service_intent", labelTh: "อาการ/สิ่งที่ต้องการซ่อม", type: "text" },
    { key: "watch_brand", labelTh: "แบรนด์/รุ่นนาฬิกา", type: "text" },
  ],
  requiredMedia: [
    { key: "watch_front", labelTh: "รูปนาฬิกาด้านหน้า", mediaType: "image" },
    { key: "watch_back", labelTh: "รูปนาฬิกาด้านหลัง", mediaType: "image" },
  ],
  classificationHints: {
    keywordsTh: [
      "ซ่อมนาฬิกา", "นาฬิกาเสีย", "สายนาฬิกา", "เข็มนาฬิกา",
      "กระจกนาฬิกา", "หน้าปัด", "นาฬิกาเดินช้า", "นาฬิกาเดินเร็ว",
      "เม็ดมะยม",
    ],
    imageLabels: ["watch", "wristwatch"],
  },
  guidedQuestions: [
    {
      trigger: "watch_front",
      questionTh: "ขอรูปนาฬิกาด้านหน้าและด้านหลังค่ะ",
      fillsMedia: "watch_front",
    },
    {
      trigger: "service_intent",
      questionTh: "นาฬิกามีอาการอย่างไรคะ — เดินช้า/หยุด/สายขาด/กระจกแตก?",
      fillsField: "service_intent",
    },
    {
      trigger: "watch_brand",
      questionTh: "ทราบแบรนด์/รุ่นนาฬิกาไหมคะ (ช่วยประเมินอะไหล่ได้ค่ะ)",
      fillsField: "watch_brand",
    },
  ],
};

const CAR_KEY_BATTERY: KnowledgeModule = {
  key: "car_key_battery",
  displayNameTh: "เปลี่ยนถ่านรีโมทกุญแจรถ (Ezy Repair)",
  categories: [
    { key: "battery_replace", labelTh: "เปลี่ยนถ่านรีโมท" },
    { key: "case_repair", labelTh: "ซ่อมปุ่ม/เคสรีโมท" },
  ],
  requiredFields: [
    { key: "car_brand_model", labelTh: "ยี่ห้อ/รุ่นรถ", type: "text" },
    { key: "service_intent", labelTh: "เปลี่ยนถ่าน หรือ ซ่อมปุ่ม/เคส", type: "choice" },
  ],
  requiredMedia: [
    { key: "remote_front", labelTh: "รูปรีโมทด้านหน้า", mediaType: "image" },
    { key: "remote_back", labelTh: "รูปรีโมทด้านหลัง", mediaType: "image" },
  ],
  classificationHints: {
    keywordsTh: [
      "กุญแจรถ", "รีโมทรถ", "รีโมทกุญแจ", "กุญแจรีโมท", "ถ่านรีโมท",
      "รีโมทกดไม่ติด", "กุญแจรถยนต์", "ถ่านกุญแจ",
    ],
    imageLabels: ["car key", "key fob", "remote", "car remote"],
  },
  guidedQuestions: [
    {
      trigger: "remote_front",
      questionTh: "ขอรูปรีโมทกุญแจด้านหน้าและด้านหลังค่ะ",
      fillsMedia: "remote_front",
    },
    {
      trigger: "car_brand_model",
      questionTh: "รถยี่ห้อ/รุ่นอะไรคะ?",
      fillsField: "car_brand_model",
    },
    {
      trigger: "service_intent",
      questionTh: "ต้องการแค่เปลี่ยนถ่าน หรือซ่อมปุ่ม/เคสด้วยคะ?",
      fillsField: "service_intent",
    },
  ],
};

const EZY_OTHER: KnowledgeModule = {
  key: "ezy_other",
  displayNameTh: "งานซ่อมอื่น ๆ (Ezy Repair)",
  categories: [{ key: "uncategorized", labelTh: "ยังไม่ระบุหมวด" }],
  requiredFields: [
    { key: "issue_description", labelTh: "อธิบายอาการ/สิ่งที่ต้องการซ่อม", type: "text" },
  ],
  requiredMedia: [
    { key: "issue_photo", labelTh: "รูปจุดที่ต้องการซ่อม", mediaType: "image" },
  ],
  classificationHints: {
    keywordsTh: ["เครื่องหนัง", "ซ่อมของ", "งานอื่น"],
    imageLabels: [],
  },
  guidedQuestions: [
    {
      trigger: "issue_description",
      questionTh: "รบกวนอธิบายอาการ และถ่ายรูปจุดที่ต้องการซ่อมให้ชัด ๆ ค่ะ",
      fillsField: "issue_description",
    },
    {
      trigger: "issue_photo",
      questionTh: "ขอรูปจุดที่ต้องการซ่อมเพิ่มได้ไหมคะ",
      fillsMedia: "issue_photo",
    },
  ],
};

// ---------- Registry + helpers --------------------------------------------

export const KNOWLEDGE_MODULES: Record<ServiceDomain, KnowledgeModule> = {
  clothing_repair: CLOTHING_REPAIR,
  shoe_repair: SHOE_REPAIR,
  luggage_repair: LUGGAGE_REPAIR,
  watch_battery: WATCH_BATTERY,
  watch_repair: WATCH_REPAIR,
  car_key_battery: CAR_KEY_BATTERY,
  ezy_other: EZY_OTHER,
};

/** The catch-all domain — used when no signal is strong enough. */
export const FALLBACK_DOMAIN: ServiceDomain = "ezy_other";

/** Look up a module by domain key. Always defined for a ServiceDomain. */
export function getModule(domain: ServiceDomain): KnowledgeModule {
  return KNOWLEDGE_MODULES[domain];
}

export function allModules(): KnowledgeModule[] {
  return SERVICE_DOMAINS.map((d) => KNOWLEDGE_MODULES[d]);
}
