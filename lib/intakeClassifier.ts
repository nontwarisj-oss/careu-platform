// Phase B foundation - mock/rule-based intake classifier.
//
// Pure. No DB, no fetch, no React. Takes the free-form Thai staff_note
// (plus a few signal fields) and returns a candidate classification.
// The /api/admin/intake-drafts/[id]/classify route stores the result in
// the ai_* columns of intake_drafts; the human owner reviews + edits
// before convert.
//
// Phase C will swap the engine for a real vision/text model. The shape
// of ClassifierInput / ClassifierResult is the long-lived contract -
// downstream consumers (admin UI + classify route) only read the
// result, never the rules.

export type GarmentType =
  | "pants"
  | "jeans"
  | "shirt"
  | "dress"
  | "suit"
  | "skirt"
  | "jacket"
  | "bag"
  | "unknown";

export type RepairCategory =
  | "hem"
  | "hem_original"
  | "zipper_replace"
  | "waist_adjust"
  | "tear_repair"
  | "patch"
  | "lining_repair"
  | "button_repair"
  | "general_alter"
  | "unknown";

export type Difficulty = "easy" | "standard" | "hard" | "expert" | "unknown";

export type ClassifierInput = {
  staffNote: string | null;
  manualJobCode?: string | null;
  urgentRequested?: boolean;
};

export type ClassifierResult = {
  garmentType: GarmentType;
  repairCategory: RepairCategory;
  repairArea: string | null;
  difficulty: Difficulty;
  /** 0..1 — how confident the rule chain is in this suggestion. */
  confidence: number;
  summary: string;
  suggestedPrice: number | null;
  /** Always true for Phase B; the owner must confirm even on a clean hit. */
  needsHumanReview: boolean;
  /** Which rule fired - useful in logs while we tune Thai keywords. */
  matchedRule: string;
};

const ZERO_RESULT: ClassifierResult = {
  garmentType: "unknown",
  repairCategory: "unknown",
  repairArea: null,
  difficulty: "unknown",
  confidence: 0.1,
  summary: "ยังจำแนกหมวดงานอัตโนมัติไม่ได้ ขอให้เจ้าของร้านตรวจดูภาพและตอบเอง",
  suggestedPrice: null,
  needsHumanReview: true,
  matchedRule: "fallback",
};

type Rule = {
  name: string;
  /** Thai keyword tokens; case-insensitive match against the note text. */
  any: string[];
  /** Optional tokens that, if present, reinforce the rule (boost confidence). */
  boost?: string[];
  result: Omit<ClassifierResult, "confidence" | "summary" | "needsHumanReview">;
  /** Base confidence on a single `any` hit; +0.1 per boost match, capped 0.85. */
  baseConfidence: number;
  summaryTh: (note: string) => string;
};

// Order matters: more specific rules first. Pants hem-original beats the
// broader pants-hem rule when "ปลายเดิม" appears.
const RULES: Rule[] = [
  {
    name: "pants_hem_original",
    any: ["ตัดต่อปลาย", "ปลายเดิม", "ต่อปลายเดิม"],
    boost: ["ยีนส์", "กางเกง"],
    result: {
      garmentType: "jeans",
      repairCategory: "hem_original",
      repairArea: "ปลายขา",
      difficulty: "standard",
      suggestedPrice: 200,
      matchedRule: "pants_hem_original",
    },
    baseConfidence: 0.7,
    summaryTh: () =>
      "ดูเหมือนงานตัดต่อปลายขาแบบเก็บปลายเดิม - น่าจะเป็นยีนส์/กางเกง",
  },
  {
    name: "pants_hem",
    any: ["ตัดขา", "ปลายขา", "เก็บปลายขา", "ขาสั้นเกิน"],
    boost: ["ยีนส์", "กางเกง"],
    result: {
      garmentType: "pants",
      repairCategory: "hem",
      repairArea: "ปลายขา",
      difficulty: "easy",
      suggestedPrice: 150,
      matchedRule: "pants_hem",
    },
    baseConfidence: 0.65,
    summaryTh: () =>
      "ดูเหมือนงานตัดปลายขา/เก็บปลายขา - ราคาเบื้องต้นตามมาตรฐาน",
  },
  {
    name: "zipper_replace",
    any: ["ซิป", "เปลี่ยนซิป", "ซิปเสีย", "ซิปขาด"],
    boost: ["กางเกง", "กระโปรง", "เสื้อ", "กระเป๋า"],
    result: {
      garmentType: "unknown",
      repairCategory: "zipper_replace",
      repairArea: "ซิป",
      difficulty: "standard",
      suggestedPrice: 130,
      matchedRule: "zipper_replace",
    },
    baseConfidence: 0.7,
    summaryTh: () =>
      "งานเปลี่ยนซิป - ตรวจชนิดซิป (พลาสติก / โลหะ / ความยาว) ก่อนยืนยันราคา",
  },
  {
    name: "waist_adjust",
    any: ["เข้าเอว", "ลดเอว", "ขยายเอว", "เอวหลวม", "เอวคับ"],
    boost: ["กางเกง", "กระโปรง"],
    result: {
      garmentType: "pants",
      repairCategory: "waist_adjust",
      repairArea: "เอว",
      difficulty: "standard",
      suggestedPrice: 200,
      matchedRule: "waist_adjust",
    },
    baseConfidence: 0.65,
    summaryTh: () => "งานปรับเอว - ตรวจขนาดที่ลด/ขยายและจำนวนนิ้ว",
  },
  {
    name: "tear_repair",
    any: ["เย็บขาด", "ผ้าขาด", "ขาด", "รอยขาด"],
    boost: ["เสื้อ", "กางเกง", "กระโปรง"],
    result: {
      garmentType: "unknown",
      repairCategory: "tear_repair",
      repairArea: "จุดที่ขาด",
      difficulty: "hard",
      suggestedPrice: 200,
      matchedRule: "tear_repair",
    },
    baseConfidence: 0.55,
    summaryTh: () =>
      "งานเย็บซ่อมจุดที่ขาด - ตรวจขนาดและตำแหน่งก่อนยืนยันราคา",
  },
  {
    name: "patch",
    any: ["ปะ", "ปะผ้า", "เสริมผ้า"],
    result: {
      garmentType: "unknown",
      repairCategory: "patch",
      repairArea: null,
      difficulty: "standard",
      suggestedPrice: 180,
      matchedRule: "patch",
    },
    baseConfidence: 0.55,
    summaryTh: () => "งานปะผ้า - ตรวจขนาดและตำแหน่งก่อนยืนยันราคา",
  },
  {
    name: "lining_repair",
    any: ["ผ้าซับใน", "ซับใน", "ลายในขาด"],
    result: {
      garmentType: "jacket",
      repairCategory: "lining_repair",
      repairArea: "ซับใน",
      difficulty: "hard",
      suggestedPrice: 300,
      matchedRule: "lining_repair",
    },
    baseConfidence: 0.6,
    summaryTh: () => "งานซ่อมผ้าซับใน - ตรวจขนาดและตำแหน่งก่อนยืนยันราคา",
  },
  {
    name: "button_repair",
    any: ["กระดุม", "ปะกระดุม", "ติดกระดุม"],
    result: {
      garmentType: "unknown",
      repairCategory: "button_repair",
      repairArea: "กระดุม",
      difficulty: "easy",
      suggestedPrice: 50,
      matchedRule: "button_repair",
    },
    baseConfidence: 0.7,
    summaryTh: () => "งานติดกระดุม - ตรวจจำนวนเม็ดก่อนยืนยันราคา",
  },
];

function normalize(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().trim();
}

/** Detect garment type independently from rule.any matches - some rules
 *  leave garmentType "unknown" until a boost token confirms it. */
function inferGarmentType(text: string): GarmentType {
  if (text.includes("ยีนส์")) return "jeans";
  if (text.includes("กางเกง")) return "pants";
  if (text.includes("กระโปรง")) return "skirt";
  if (text.includes("เสื้อสูท") || text.includes("สูท")) return "suit";
  if (text.includes("เดรส") || text.includes("ชุดเดรส")) return "dress";
  if (text.includes("แจ็คเก็ต") || text.includes("เสื้อโค้ท")) return "jacket";
  if (text.includes("กระเป๋า")) return "bag";
  if (text.includes("เสื้อ")) return "shirt";
  return "unknown";
}

export function classifyIntake(input: ClassifierInput): ClassifierResult {
  const note = normalize(input.staffNote);
  if (!note) return ZERO_RESULT;

  for (const rule of RULES) {
    const hit = rule.any.some((token) => note.includes(token.toLowerCase()));
    if (!hit) continue;
    const boosts =
      rule.boost?.filter((token) => note.includes(token.toLowerCase()))
        .length ?? 0;
    const confidence = Math.min(0.85, rule.baseConfidence + boosts * 0.1);
    const inferredGarment = inferGarmentType(note);
    return {
      garmentType:
        rule.result.garmentType === "unknown"
          ? inferredGarment
          : rule.result.garmentType,
      repairCategory: rule.result.repairCategory,
      repairArea: rule.result.repairArea,
      difficulty: rule.result.difficulty,
      confidence,
      summary: rule.summaryTh(input.staffNote ?? ""),
      suggestedPrice: rule.result.suggestedPrice,
      needsHumanReview: true,
      matchedRule: rule.name,
    };
  }

  // No rule fired - try garment-only inference for a weak signal.
  const garment = inferGarmentType(note);
  if (garment !== "unknown") {
    return {
      ...ZERO_RESULT,
      garmentType: garment,
      confidence: 0.25,
      summary:
        "ระบุได้แค่ประเภทเสื้อผ้าเบื้องต้น - ขอให้เจ้าของร้านดูภาพและเลือกหมวดงานเอง",
      matchedRule: "garment_only",
    };
  }
  return ZERO_RESULT;
}
