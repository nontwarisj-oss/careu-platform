import supabase from "@/lib/supabase";
import { normalizeJobId } from "@/lib/jobId";

export type BusinessType = "care_u" | "ezy_repair";

export type SmartOrderInput = {
  customerId: string;
  customerName: string;
  customerType?: string | null;
  branchId: string;
  /** Care U = clothing alteration; Ezy Repair = shoes/bags/luggage. */
  businessType?: BusinessType;
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
  /**
   * Manual job id from the staff (Care U). Ignored when businessType is
   * ezy_repair — that path always generates server-side via the RPC.
   */
  jobId?: string | null;
  /** users.id of the staff member creating this order (for audit log). */
  createdBy?: string | null;
  /** Optional ISO date string the customer expects to pick up. */
  dueDate?: string | null;
  /** Optional technician name / handle assigned at intake. */
  tech?: string | null;
};

type InsertResult = {
  orderId: string | null;
  jobId: string | null;
  error: string | null;
};

const isMissingColumn = (msg: string | undefined): boolean =>
  !!msg &&
  /column .* does not exist|could not find.*column|cache.*schema|unknown column|schema cache/i.test(
    msg
  );

const isDuplicateJobId = (msg: string | undefined): boolean =>
  !!msg &&
  /duplicate key|orders_job_id_unique_idx|already exists/i.test(msg);

async function jobIdExistsScoped(
  candidate: string,
  branchId: string,
  businessType: BusinessType
): Promise<boolean> {
  // The new scoped unique index is on (branch_id, business_type, job_id);
  // check the same triple so manual Care U ids can collide with Ezy ids in
  // different branches without false positives.
  const res = await supabase
    .from("orders")
    .select("id", { head: true, count: "exact" })
    .eq("job_id", candidate)
    .eq("branch_id", branchId)
    .eq("business_type", businessType);
  if (res.error) {
    if (isMissingColumn(res.error.message)) {
      // Fall back to a global check when business_type isn't migrated yet.
      const legacy = await supabase
        .from("orders")
        .select("id", { head: true, count: "exact" })
        .eq("job_id", candidate);
      if (legacy.error) {
        if (isMissingColumn(legacy.error.message)) return false;
        return true;
      }
      return (legacy.count ?? 0) > 0;
    }
    return true;
  }
  return (res.count ?? 0) > 0;
}

/**
 * Resolve the final job_id. Care U is manual-only; Ezy Repair always goes
 * through the server-side RPC so the daily sequence stays correct under
 * concurrency.
 */
async function resolveJobId(
  input: SmartOrderInput
): Promise<{ jobId: string | null; error: string | null }> {
  const businessType: BusinessType = input.businessType ?? "care_u";

  if (businessType === "ezy_repair") {
    const rpc = await supabase.rpc("generate_ezy_job_id", {
      p_branch: input.branchId,
    });
    if (rpc.error) {
      // RPC missing → migration not applied. Skip the column entirely.
      if (isMissingColumn(rpc.error.message)) {
        return { jobId: null, error: null };
      }
      return { jobId: null, error: rpc.error.message };
    }
    const generated = typeof rpc.data === "string" ? rpc.data : null;
    return { jobId: generated, error: null };
  }

  // Care U — manual entry required.
  const manual = normalizeJobId(input.jobId);
  if (!manual) {
    return {
      jobId: null,
      error: "Care U ต้องกรอก Job ID เอง (ไม่ใช้การสร้างอัตโนมัติ)",
    };
  }
  if (await jobIdExistsScoped(manual, input.branchId, businessType)) {
    return {
      jobId: null,
      error: `Job ID "${manual}" ถูกใช้แล้วในสาขานี้ — ลองอันใหม่`,
    };
  }
  return { jobId: manual, error: null };
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
 * Phase 20: attribute this fresh order to the customer's most recent
 * campaign send (if any). Best-effort — failures must NEVER block
 * order creation. Denormalises the campaign source onto the orders
 * row so future queries don't always need to join
 * campaign_response_metrics.
 *
 * Called via POST to /api/internal/attribute-order from the server-
 * only side. We use HTTP rather than a direct import because
 * orderCreate runs in a browser-attached supabase context (anon key)
 * — the attribution library needs the admin client.
 */
async function attributeOrderBestEffort(
  orderId: string,
  customerId: string | null,
  orderValue: number,
  branchId: string | null
): Promise<void> {
  if (!customerId) return;
  try {
    await fetch("/api/internal/attribute-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        customerId,
        orderValue,
        branchId,
      }),
    });
  } catch (err) {
    // Best-effort. Attribution failures must never propagate.
    console.warn(
      "[orderCreate] attribution call failed",
      err instanceof Error ? err.message : String(err)
    );
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

  const businessType: BusinessType = input.businessType ?? "care_u";

  const v4 = {
    ...v3,
    job_id: jobId,
    created_by: input.createdBy ?? null,
    business_type: businessType,
    due_date: input.dueDate ?? null,
    tech: input.tech ?? null,
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
    if (result.orderId) {
      await writeAuditCreated(result.orderId, jobId, input.createdBy);
      void attributeOrderBestEffort(
        result.orderId,
        input.customerId,
        input.total,
        input.branchId
      );
    }
    return { ...result, jobId };
  }

  // Tier 3 — full smart schema (no job_id)
  result = await attempt(v3);
  if (!isMissingColumn(result.error ?? undefined)) {
    if (result.orderId) {
      await writeAuditCreated(result.orderId, null, input.createdBy);
      void attributeOrderBestEffort(
        result.orderId,
        input.customerId,
        input.total,
        input.branchId
      );
    }
    return { ...result, jobId: null };
  }

  // Tier 2 — intake-extension schema
  result = await attempt(v2);
  if (!isMissingColumn(result.error ?? undefined)) {
    if (result.orderId) {
      await writeAuditCreated(result.orderId, null, input.createdBy);
      void attributeOrderBestEffort(
        result.orderId,
        input.customerId,
        input.total,
        input.branchId
      );
    }
    return { ...result, jobId: null };
  }

  // Tier 1 — legacy schema. Preserve urgent intent in the item name.
  const legacyWithUrgent = {
    ...legacy,
    item_name: itemNameBase + (input.urgent ? " [ด่วน]" : ""),
  };
  const final = await attempt(legacyWithUrgent);
  if (final.orderId) {
    await writeAuditCreated(final.orderId, null, input.createdBy);
    void attributeOrderBestEffort(
      final.orderId,
      input.customerId,
      input.total,
      input.branchId
    );
  }
  return { ...final, jobId: null };
}
