// Local pricing database modelled on Care_U_Pricing_Database_v2.xlsx
//   - sheet 2_Services      → SERVICES + SERVICE_CATEGORIES
//   - sheet 3_Modifiers     → URGENT_MODIFIERS
//   - sheet 4_Promotions    → PROMOTIONS
//   - sheet 5_Special_Rules → ServiceItem.isSpecial / basePrice = null
//   - sheet 6_Customer_Types→ CUSTOMER_TYPES
//   - sheet 9_Templates     → ServiceItem.templateTh
//
// Keep this file as the single source of truth for now; later we can swap the
// constants for a Supabase table or a Google Sheet sync without changing call
// sites that use the getters / computeDiscount helpers below.

export type ServiceCategoryKey =
  | "alteration"
  | "repair"
  | "leather"
  | "luggage"
  | "drycleaning"
  | "special";

export type ServiceCategory = {
  code: ServiceCategoryKey;
  labelTh: string;
  labelEn: string;
};

export const SERVICE_CATEGORIES: ServiceCategory[] = [
  { code: "alteration", labelTh: "ดัดแปลงตัดเย็บ", labelEn: "Alteration" },
  { code: "repair", labelTh: "ซ่อมแซม", labelEn: "Repair" },
  { code: "leather", labelTh: "งานหนัง", labelEn: "Leather" },
  { code: "luggage", labelTh: "กระเป๋า/สัมภาระ", labelEn: "Luggage" },
  { code: "drycleaning", labelTh: "ซักแห้ง", labelEn: "Dry cleaning" },
  { code: "special", labelTh: "งานพิเศษ", labelEn: "Special" },
];

export type ServiceItem = {
  code: string;
  category: ServiceCategoryKey;
  nameTh: string;
  nameEn: string;
  /** null = "ต้องประเมินราคา" — staff enters price manually. */
  basePrice: number | null;
  templateTh: string;
  templateEn?: string;
  isSpecial?: boolean;
  /** Default urgent surcharge applied when the staff toggles "งานด่วน". */
  urgentFeeDefault?: number;
};

export const SERVICES: ServiceItem[] = [
  // ---- Alteration -------------------------------------------------------
  {
    code: "ALT-001",
    category: "alteration",
    nameTh: "ตัดขากางเกง",
    nameEn: "Hem pants",
    basePrice: 80,
    templateTh: "บริการตัดขากางเกงตามความยาวที่ลูกค้ากำหนด",
  },
  {
    code: "ALT-002",
    category: "alteration",
    nameTh: "ตัดเอวกางเกง",
    nameEn: "Resize waist",
    basePrice: 120,
    templateTh: "บริการตัดเอวกางเกงตามขนาดที่ลูกค้ากำหนด",
  },
  {
    code: "ALT-003",
    category: "alteration",
    nameTh: "ตัดแขนเสื้อ",
    nameEn: "Shorten sleeves",
    basePrice: 100,
    templateTh: "บริการตัดแขนเสื้อตามความยาวที่ลูกค้ากำหนด",
  },
  {
    code: "ALT-004",
    category: "alteration",
    nameTh: "ปรับขนาดเสื้อ/กางเกง",
    nameEn: "Resize garment",
    basePrice: 150,
    templateTh: "บริการปรับขนาดเสื้อ/กางเกงตามรอบตัวที่ต้องการ",
  },

  // ---- Repair -----------------------------------------------------------
  {
    code: "REP-001",
    category: "repair",
    nameTh: "ปะรูเสื้อ/กางเกง",
    nameEn: "Patch hole",
    basePrice: 60,
    templateTh: "บริการปะรูเสื้อหรือกางเกงด้วยเทคนิคที่เหมาะสมกับเนื้อผ้า",
  },
  {
    code: "REP-002",
    category: "repair",
    nameTh: "เปลี่ยนซิป",
    nameEn: "Replace zipper",
    basePrice: 150,
    templateTh: "บริการเปลี่ยนซิปกางเกง/กระโปรง/เสื้อแจ๊คเก็ต",
  },
  {
    code: "REP-003",
    category: "repair",
    nameTh: "ติดกระดุม (ต่อเม็ด)",
    nameEn: "Sew buttons (each)",
    basePrice: 20,
    templateTh: "บริการติดกระดุม คิดราคาต่อเม็ด",
  },
  {
    code: "REP-004",
    category: "repair",
    nameTh: "เย็บตะเข็บที่ขาด",
    nameEn: "Resew seam",
    basePrice: 40,
    templateTh: "บริการเย็บตะเข็บที่ขาดให้กลับมาแน่นหนา",
  },

  // ---- Leather ----------------------------------------------------------
  {
    code: "LTH-001",
    category: "leather",
    nameTh: "ซ่อมหนังถลอก/ขาด",
    nameEn: "Leather scuff repair",
    basePrice: null,
    isSpecial: true,
    templateTh: "ซ่อมหนังถลอก/ขาด ต้องประเมินราคาตามลักษณะของชิ้นงาน",
  },
  {
    code: "LTH-002",
    category: "leather",
    nameTh: "ทาสีหนัง",
    nameEn: "Leather repaint",
    basePrice: null,
    isSpecial: true,
    templateTh: "ทาสีหนังให้กลับมาเงางาม ต้องประเมินราคาตามขนาดและสี",
  },

  // ---- Luggage ----------------------------------------------------------
  {
    code: "LUG-001",
    category: "luggage",
    nameTh: "ซ่อม/เปลี่ยนล้อกระเป๋าเดินทาง",
    nameEn: "Repair luggage wheel",
    basePrice: 250,
    templateTh: "บริการซ่อมหรือเปลี่ยนล้อกระเป๋าเดินทาง (ราคาต่อล้อ)",
  },
  {
    code: "LUG-002",
    category: "luggage",
    nameTh: "ซ่อมหูจับกระเป๋า",
    nameEn: "Repair luggage handle",
    basePrice: null,
    isSpecial: true,
    templateTh: "ซ่อมหูจับ/มือจับกระเป๋า ต้องประเมินราคาตามลักษณะ",
  },

  // ---- Dry cleaning -----------------------------------------------------
  {
    code: "DRY-001",
    category: "drycleaning",
    nameTh: "ซักแห้งเสื้อเชิ้ต",
    nameEn: "Dry-clean shirt",
    basePrice: 80,
    templateTh: "บริการซักแห้งเสื้อเชิ้ตด้วยน้ำยามาตรฐาน",
  },
  {
    code: "DRY-002",
    category: "drycleaning",
    nameTh: "ซักแห้งสูท",
    nameEn: "Dry-clean suit",
    basePrice: 200,
    templateTh: "บริการซักแห้งสูทพร้อมรีดและจัดทรง",
  },

  // ---- Special / other --------------------------------------------------
  {
    code: "SPC-001",
    category: "special",
    nameTh: "งานปักพิเศษ",
    nameEn: "Custom embroidery",
    basePrice: null,
    isSpecial: true,
    templateTh: "งานปักออกแบบพิเศษ ต้องประเมินราคาตามแบบที่ลูกค้าต้องการ",
  },
  {
    code: "SPC-999",
    category: "special",
    nameTh: "งานอื่นๆ (ระบุเอง)",
    nameEn: "Other",
    basePrice: null,
    isSpecial: true,
    templateTh: "",
  },
];

export type Promotion = {
  code: string;
  nameTh: string;
  nameEn: string;
  type: "percent" | "flat" | "manual";
  /** For percent: 0-100. For flat: ฿. For manual: ignored. */
  value: number;
};

export const PROMOTIONS: Promotion[] = [
  { code: "NONE", nameTh: "ไม่มีโปรโมชัน", nameEn: "No promotion", type: "manual", value: 0 },
  { code: "B2S", nameTh: "Back to School (-10%)", nameEn: "Back to School", type: "percent", value: 10 },
  { code: "MANUAL", nameTh: "ส่วนลดเอง (กรอกจำนวน)", nameEn: "Manual discount", type: "manual", value: 0 },
];

export type CustomerType = {
  code: string;
  nameTh: string;
  nameEn: string;
};

export const CUSTOMER_TYPES: CustomerType[] = [
  { code: "general", nameTh: "ทั่วไป", nameEn: "General" },
  { code: "student", nameTh: "นักเรียน/นักศึกษา", nameEn: "Student" },
  { code: "regular", nameTh: "ลูกค้าประจำ", nameEn: "Regular" },
  { code: "vip", nameTh: "VIP", nameEn: "VIP" },
];

export type UrgentModifier = {
  code: string;
  nameTh: string;
  fee: number;
};

export const URGENT_MODIFIERS: UrgentModifier[] = [
  { code: "urgent_30", nameTh: "งานด่วน +30 ฿", fee: 30 },
  { code: "urgent_50", nameTh: "งานด่วน +50 ฿", fee: 50 },
];

export function getServiceByCode(code: string | null | undefined): ServiceItem | undefined {
  if (!code) return undefined;
  return SERVICES.find((s) => s.code === code);
}

export function getCategoryByCode(code: string | null | undefined): ServiceCategory | undefined {
  if (!code) return undefined;
  return SERVICE_CATEGORIES.find((c) => c.code === code);
}

export function getPromotionByCode(
  code: string | null | undefined
): Promotion | undefined {
  if (!code) return undefined;
  return PROMOTIONS.find((p) => p.code === code);
}

export function getCustomerTypeByCode(
  code: string | null | undefined
): CustomerType | undefined {
  if (!code) return undefined;
  return CUSTOMER_TYPES.find((t) => t.code === code);
}

/**
 * Resolve a discount amount for the given subtotal.
 * - `manualDiscount` overrides any promotion (used by promotion = MANUAL).
 * - Promotion `percent` discounts are rounded down to whole baht.
 * - The returned amount is clamped to the subtotal.
 */
export function computeDiscount(
  subtotal: number,
  promotionCode: string | null | undefined,
  manualDiscount?: number
): number {
  const promo = getPromotionByCode(promotionCode);
  if (promo?.code === "MANUAL" || (manualDiscount && manualDiscount > 0)) {
    return Math.min(Math.max(0, Math.floor(manualDiscount ?? 0)), subtotal);
  }
  if (!promo || promo.code === "NONE") return 0;
  if (promo.type === "percent") {
    return Math.min(Math.floor((subtotal * promo.value) / 100), subtotal);
  }
  if (promo.type === "flat") {
    return Math.min(promo.value, subtotal);
  }
  return 0;
}
