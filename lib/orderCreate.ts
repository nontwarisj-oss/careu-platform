import supabase from "@/lib/supabase";
import { generateJobIdCandidate, normalizeJobId } from "@/lib/jobId";

export type SmartOrderInput = {
  customerId: string;
  customerName: string;
  customerType?: string | null;
  branchId: string;
  serviceCategory?: string | null;
  serviceCode?: string | null;
  /** Human-readable service name; lands in item_name when extended columns are missing. */
  serviceName: string;
  templateText?: string | null;
  quantity: number;
  subtotal: number;
  urgent: boolean;
  urgentFee: number;
  promotionCode?: string | null;
  discount: number;
  total: number;
  notes?: string | null;
  status?: string;
  /** Optional human-readable job id. When omitted we auto-generate. */
  jobId?: string | null;
  /** When true and jobId is empty, auto-generate. When false and jobId is empty, leave null. */
  autoJobId?: boolean;
  /** users.id of the staff member creating this order (for audit log). */
  createdBy?: string | null;
};

type InsertResult = {
  orderId: string | null;
  jobId: string | null;
  error: string | null;
};

const MAX_JOB_ID_ATTEMPTS = 8;

const isMissingColumn = (msg: string | undefined): boolean =>
  !!msg &&
  /column .* does not exist|could not find.*column|cache.*schema|unknown column|schema cache/i.test(
    msg
  );

const isDuplicateJobId = (msg: string | undefined): boolean =>
  !!msg &&
  /duplicate key|orders_job_id_unique_idx|already exists/i.test(msg);

async function jobIdExists(candidate: string): Promise<boolean> {
  const res = await supabase
    .from("orders")
    .select("id", { head: true, count: "exact" })
    .eq("job_id", candidate);
  if (res.error) {
    // Column doesn't exist yet → migration not applied. Treat as "free" so
    // the caller proceeds; the column won't be written either.
    if (isMissingColumn(res.error.message)) return false;
    // Any other error → assume not free so we don't double-write.
    return true;
  }
  return (res.count ?? 0) > 0;
}

/** Resolve the final job_id to attempt: manual entry if provided, else auto. */
async function resolveJobId(input: SmartOrderInput): Promise<{
  jobId: string | null;
  error: string | null;
}> {
  const manual = normalizeJobId(input.jobId);
  if (manual) {
    if (await jobIdExists(manual)) {
      return {
        jobId: null,
        error: `Job ID "${manual}" ถูกใช้ไปแล้ว — ลองอันใหม่`,
      };
    }
    return { jobId: manual, error: null };
  }
  if (input.autoJobId === false) {
    return { jobId: null, error: null };
  }
  for (let i = 0; i < MAX_JOB_ID_ATTEMPTS; i++) {
    const candidate = generateJobIdCandidate();
    if (!(await jobIdExists(candidate))) {
      return { jobId: candidate, error: null };
    }
  }
  return {
    jobId: null,
    error:
      "สร้าง Job ID อัตโนมัติไม่สำเร็จ (ชน 8 ครั้งติด) — ลองอีกครั้ง หรือกรอกเอง",
  };
}

async function attempt(
  payload: object
): Promise<{ orderId: string | null; error: string | null }> {
  const res = await supabase
    .from("orders")
    .insert(payload)
    .select("id")
    .maybeSingle();
  if (res.error) {
    return { orderId: null, error: res.error.message };
  }
  if (!res.data) {
    return { orderId: null, error: "Insert returned no row" };
  }
  return { orderId: String((res.data as { id: string }).id), error: null };
}

async function writeAuditCreated(
  orderId: string,
  jobId: string | null,
  createdBy: string | null | undefined
): Promise<void> {
  const res = await supabase.from("order_audit_log").insert({
    order_id: orderId,
    action: "created",
    after_value: jobId ?? null,
    changed_by: createdBy ?? null,
  });
  if (res.error && !isMissingColumn(res.error.message)) {
    console.warn("[orderCreate] audit write failed", res.error.message);
  }
}

/**
 * Insert a smart order with progressive fallback so the form keeps working
 * across migration states:
 *   v4 = job_id + created_by (20260520)
 *   v3 = subtotal, discount, service_category/code/name, quantity, promotion_code, customer_type, template_text
 *   v2 = urgent/urgent_fee/notes/branch_id columns
 *   v1 = legacy (customer_id, customer_name, item_name, price, status)
 *
 * Urgent intent is suffixed onto item_name in the v1 fallback so it's not lost.
 */
export async function createSmartOrder(
  input: SmartOrderInput
): Promise<InsertResult> {
  const quantity = Math.max(1, Math.floor(input.quantity || 1));
  const itemNameBase =
    input.serviceName + (quantity > 1 ? ` x${quantity}` : "");

  const resolved = await resolveJobId(input);
  if (resolved.error) {
    return { orderId: null, jobId: null, error: resolved.error };
  }
  const jobId = resolved.jobId;

  const legacy = {
    customer_id: input.customerId,
    customer_name: input.customerName,
    item_name: itemNameBase,
    price: input.total,
    status: input.status ?? "pending",
  };

  const v2 = {
    ...legacy,
    branch_id: input.branchId,
    urgent: input.urgent,
    urgent_fee: input.urgent ? input.urgentFee : 0,
    notes: input.notes || null,
  };

  const v3 = {
    ...v2,
    subtotal: input.subtotal,
    discount: input.discount,
    service_category: input.serviceCategory ?? null,
    service_code: input.serviceCode ?? null,
    service_name: input.serviceName,
    quantity,
    template_text: input.templateText ?? null,
    customer_type: input.customerType ?? null,
    promotion_code: input.promotionCode ?? null,
    payment_status: "unpaid",
    document_type: "intake_quote_receipt",
  };

  const v4 = {
    ...v3,
    job_id: jobId,
    created_by: input.createdBy ?? null,
  };

  // Tier 4 — auth/audit schema
  let result = await attempt(v4);
  if (isDuplicateJobId(result.error ?? undefined) && jobId) {
    // Race: another order grabbed this id between our check and insert.
    return {
      orderId: null,
      jobId: null,
      error: `Job ID "${jobId}" ถูกใช้ในช่วงเวลาเดียวกัน — ลองใหม่`,
    };
  }
  if (!isMissingColumn(result.error ?? undefined)) {
    if (result.orderId) await writeAuditCreated(result.orderId, jobId, input.createdBy);
    return { ...result, jobId };
  }

  // Tier 3 — full smart schema (no job_id)
  result = await attempt(v3);
  if (!isMissingColumn(result.error ?? undefined)) {
    if (result.orderId) await writeAuditCreated(result.orderId, null, input.createdBy);
    return { ...result, jobId: null };
  }

  // Tier 2 — intake-extension schema
  result = await attempt(v2);
  if (!isMissingColumn(result.error ?? undefined)) {
    if (result.orderId) await writeAuditCreated(result.orderId, null, input.createdBy);
    return { ...result, jobId: null };
  }

  // Tier 1 — legacy schema. Preserve urgent intent in the item name.
  const legacyWithUrgent = {
    ...legacy,
    item_name: itemNameBase + (input.urgent ? " [ด่วน]" : ""),
  };
  const final = await attempt(legacyWithUrgent);
  if (final.orderId) await writeAuditCreated(final.orderId, null, input.createdBy);
  return { ...final, jobId: null };
}
