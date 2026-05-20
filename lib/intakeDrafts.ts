// Mobile Intake Draft — shared types + status vocabulary.
//
// One place for the draft shape and the status workflow so the mobile
// capture page, the admin review queue, and the API routes all agree.

// ---------- Status workflow ------------------------------------------------

export type DraftStatus =
  | "NEW"
  | "AI_PROCESSING"
  | "AI_REVIEW_READY"
  | "ADMIN_REVIEWING"
  | "NEED_CUSTOMER_INFO"
  | "APPROVED_TO_ORDER"
  | "CONVERTED_TO_ORDER"
  | "CANCELLED";

export const DRAFT_STATUSES: DraftStatus[] = [
  "NEW",
  "AI_PROCESSING",
  "AI_REVIEW_READY",
  "ADMIN_REVIEWING",
  "NEED_CUSTOMER_INFO",
  "APPROVED_TO_ORDER",
  "CONVERTED_TO_ORDER",
  "CANCELLED",
];

/** Thai UI label per status. */
export const DRAFT_STATUS_LABELS_TH: Record<DraftStatus, string> = {
  NEW: "งานใหม่",
  AI_PROCESSING: "AI กำลังอ่านข้อมูล",
  AI_REVIEW_READY: "รอ Admin ตรวจ",
  ADMIN_REVIEWING: "กำลังตรวจ",
  NEED_CUSTOMER_INFO: "ต้องถามลูกค้าเพิ่ม",
  APPROVED_TO_ORDER: "อนุมัติสร้างงาน",
  CONVERTED_TO_ORDER: "สร้างใบงานแล้ว",
  CANCELLED: "ยกเลิก",
};

/** Tailwind badge classes per status. */
export const DRAFT_STATUS_BADGE: Record<DraftStatus, string> = {
  NEW: "border-green-300 bg-green-50 text-green-800",
  AI_PROCESSING: "border-indigo-300 bg-indigo-50 text-indigo-800",
  AI_REVIEW_READY: "border-blue-300 bg-blue-50 text-blue-800",
  ADMIN_REVIEWING: "border-amber-300 bg-amber-50 text-amber-800",
  NEED_CUSTOMER_INFO: "border-orange-300 bg-orange-50 text-orange-800",
  APPROVED_TO_ORDER: "border-emerald-300 bg-emerald-50 text-emerald-800",
  CONVERTED_TO_ORDER: "border-gray-300 bg-gray-100 text-gray-700",
  CANCELLED: "border-red-300 bg-red-50 text-red-700",
};

export function isDraftStatus(value: unknown): value is DraftStatus {
  return (
    typeof value === "string" &&
    (DRAFT_STATUSES as string[]).includes(value)
  );
}

// ---------- Media ----------------------------------------------------------

export type DraftMediaType = "image" | "video" | "audio";

export type IntakeDraftMedia = {
  id: string;
  mediaType: DraftMediaType;
  /** Storage object path inside the private customer-uploads bucket. */
  fileUrl: string;
  thumbnailUrl: string | null;
  aiDescription: string | null;
  /** Short-lived signed read URL — populated by the admin list route. */
  signedUrl: string | null;
  createdAt: string;
};

// ---------- Draft ----------------------------------------------------------

export type IntakeDraft = {
  id: string;
  /** System-internal short id (DYYMMDD-NNN). Auto-generated fallback only —
   *  the user-facing identifier is `manualJobCode`, which the staff types
   *  and writes on the bag tag. */
  draftCode: string;
  /** The job code the front-counter staff typed at intake; carried into
   *  orders.job_id on convert. Nullable for legacy drafts only — the
   *  mobile-intake form requires it for every new draft. */
  manualJobCode: string | null;
  branchId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  staffNote: string | null;
  urgentRequested: boolean;
  status: DraftStatus;
  aiSummary: string | null;
  aiSuggestedCategory: string | null;
  aiSuggestedServiceCode: string | null;
  aiConfidence: number | null;
  adminReviewNote: string | null;
  /** Set by the convert route once a real order is created. */
  convertedOrderId: string | null;
  /** customers.id linked / created by the convert route. */
  customerId: string | null;
  /** Final price the admin approved (from service_price_master via the
   *  pure quote engine). Phase A: written by the convert route itself. */
  approvedPrice: number | null;
  createdAt: string;
  updatedAt: string;
  media: IntakeDraftMedia[];
};

/** Map a raw public.intake_drafts row to a camelCased IntakeDraft. */
export function rowToIntakeDraft(
  row: Record<string, unknown>,
  media: IntakeDraftMedia[] = []
): IntakeDraft {
  const statusRaw = String(row.status ?? "NEW");
  return {
    id: String(row.id ?? ""),
    draftCode: String(row.draft_code ?? ""),
    manualJobCode: row.manual_job_code ? String(row.manual_job_code) : null,
    branchId: row.branch_id ? String(row.branch_id) : null,
    customerName: row.customer_name ? String(row.customer_name) : null,
    customerPhone: row.customer_phone ? String(row.customer_phone) : null,
    staffNote: row.staff_note ? String(row.staff_note) : null,
    urgentRequested: row.urgent_requested === true,
    status: isDraftStatus(statusRaw) ? statusRaw : "NEW",
    aiSummary: row.ai_summary ? String(row.ai_summary) : null,
    aiSuggestedCategory: row.ai_suggested_category
      ? String(row.ai_suggested_category)
      : null,
    aiSuggestedServiceCode: row.ai_suggested_service_code
      ? String(row.ai_suggested_service_code)
      : null,
    aiConfidence:
      row.ai_confidence === null || row.ai_confidence === undefined
        ? null
        : Number(row.ai_confidence),
    adminReviewNote: row.admin_review_note
      ? String(row.admin_review_note)
      : null,
    convertedOrderId: row.converted_order_id
      ? String(row.converted_order_id)
      : null,
    customerId: row.customer_id ? String(row.customer_id) : null,
    approvedPrice:
      row.approved_price === null || row.approved_price === undefined
        ? null
        : Number(row.approved_price),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    media,
  };
}

/** Map a raw public.intake_draft_media row to a camelCased media item. */
export function rowToIntakeDraftMedia(
  row: Record<string, unknown>,
  signedUrl: string | null = null
): IntakeDraftMedia {
  const typeRaw = String(row.media_type ?? "image");
  const mediaType: DraftMediaType =
    typeRaw === "video" || typeRaw === "audio" ? typeRaw : "image";
  return {
    id: String(row.id ?? ""),
    mediaType,
    fileUrl: String(row.file_url ?? ""),
    thumbnailUrl: row.thumbnail_url ? String(row.thumbnail_url) : null,
    aiDescription: row.ai_description ? String(row.ai_description) : null,
    signedUrl,
    createdAt: String(row.created_at ?? ""),
  };
}
