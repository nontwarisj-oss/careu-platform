// Pure validation helpers. Three-layer defense in depth:
//
//   1. UI: forms call these before submitting, surface friendly Thai
//      error strings to the operator.
//   2. App: route handlers / service helpers can re-validate so the API
//      never trusts the UI alone.
//   3. DB: CHECK constraints from 20260526 reject anything that slips
//      past the first two — the last line of defence.
//
// No DB calls here. No React imports. Safe everywhere.

import { isValidJobId } from "@/lib/jobId";

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

// ---------- Order ---------------------------------------------------------

export type OrderValidationInput = {
  branchId?: string | null;
  businessType?: "care_u" | "ezy_repair";
  serviceName?: string | null;
  /** Care U manual job id; ignored for ezy_repair (server-generated). */
  jobId?: string | null;
  quantity?: number;
  unitPrice?: number;
  urgentFee?: number;
  discount?: number;
  total?: number;
  dueDate?: string | null;
};

export function validateOrderInput(input: OrderValidationInput): ValidationResult {
  const errors: string[] = [];

  if (!input.branchId || !String(input.branchId).trim()) {
    errors.push("ต้องระบุสาขา");
  }
  if (!input.serviceName || !String(input.serviceName).trim()) {
    errors.push("ต้องเลือกบริการ");
  }
  if (input.businessType === "care_u") {
    if (!input.jobId || !String(input.jobId).trim()) {
      errors.push("Care U ต้องกรอก Job ID เอง");
    } else if (!isValidJobId(String(input.jobId).trim())) {
      errors.push("Job ID ที่กรอกไม่ถูกต้อง — ใช้ A–Z, 0–9, _-./");
    }
  }
  if (
    input.quantity !== undefined &&
    (!Number.isFinite(input.quantity) || (input.quantity ?? 0) < 1)
  ) {
    errors.push("จำนวนต้องเป็นจำนวนเต็มมากกว่าหรือเท่ากับ 1");
  }
  if (
    input.unitPrice !== undefined &&
    (!Number.isFinite(input.unitPrice) || (input.unitPrice ?? 0) < 0)
  ) {
    errors.push("ราคาต่อหน่วยต้องไม่น้อยกว่า 0");
  }
  if (
    input.urgentFee !== undefined &&
    (!Number.isFinite(input.urgentFee) || (input.urgentFee ?? 0) < 0)
  ) {
    errors.push("ค่างานด่วนต้องไม่น้อยกว่า 0");
  }
  if (
    input.discount !== undefined &&
    (!Number.isFinite(input.discount) || (input.discount ?? 0) < 0)
  ) {
    errors.push("ส่วนลดต้องไม่น้อยกว่า 0");
  }
  if (
    input.total !== undefined &&
    (!Number.isFinite(input.total) || (input.total ?? 0) < 0)
  ) {
    errors.push("ยอดรวมต้องไม่น้อยกว่า 0");
  }
  if (input.dueDate) {
    if (!isValidIsoDate(input.dueDate)) {
      errors.push("วันนัดรับไม่ใช่รูปแบบวันที่ที่ถูกต้อง");
    } else if (input.dueDate < todayIso()) {
      errors.push("วันนัดรับต้องไม่ใช่วันที่ในอดีต");
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

// ---------- Expense -------------------------------------------------------

export type ExpenseValidationInput = {
  branchId?: string | null;
  category?: string | null;
  description?: string | null;
  notes?: string | null;
  amount?: number;
  expenseDate?: string | null;
  paymentMethod?: string | null;
};

export function validateExpenseInput(input: ExpenseValidationInput): ValidationResult {
  const errors: string[] = [];

  if (!input.branchId || !String(input.branchId).trim()) {
    errors.push("ต้องระบุสาขา");
  }
  if (!input.category || !String(input.category).trim()) {
    errors.push("ต้องเลือกหมวดค่าใช้จ่าย");
  }
  if (
    input.amount === undefined ||
    !Number.isFinite(input.amount) ||
    (input.amount ?? 0) < 0
  ) {
    errors.push("จำนวนเงินต้องเป็นตัวเลขไม่น้อยกว่า 0");
  }
  if (input.expenseDate) {
    if (!isValidIsoDate(input.expenseDate)) {
      errors.push("วันที่ใช้จ่ายไม่ใช่รูปแบบวันที่ที่ถูกต้อง");
    }
    // Allow expense_date in the past (you can record yesterday's rent).
    // Future dates are unusual but not forbidden — staff may log a
    // scheduled subscription early.
  }
  // Either description or notes must be present for audit traceability.
  const hasDescription = !!(input.description && String(input.description).trim());
  const hasNotes = !!(input.notes && String(input.notes).trim());
  if (!hasDescription && !hasNotes) {
    errors.push("กรอกรายละเอียดหรือบันทึกอย่างน้อย 1 ช่อง");
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

// ---------- Pricing -------------------------------------------------------

export type PricingValidationInput = {
  serviceCode?: string | null;
  category?: string | null;
  displayName?: string | null;
  pricingType?: "fixed" | "estimate_required";
  basePrice?: number | null;
  urgentFeeDefault?: number;
};

export function validatePricingInput(input: PricingValidationInput): ValidationResult {
  const errors: string[] = [];

  if (!input.serviceCode || !String(input.serviceCode).trim()) {
    errors.push("service_code ห้ามว่าง");
  } else if (!/^[A-Za-z0-9_\-./]{1,32}$/.test(String(input.serviceCode).trim())) {
    errors.push("service_code รูปแบบไม่ถูกต้อง (อักษร/ตัวเลข/_-./ 1–32 ตัว)");
  }
  if (!input.category) errors.push("เลือกหมวดบริการ");
  if (!input.displayName || !String(input.displayName).trim()) {
    errors.push("display_name ห้ามว่าง");
  }
  if (input.pricingType === "fixed") {
    if (
      input.basePrice === null ||
      input.basePrice === undefined ||
      !Number.isFinite(input.basePrice) ||
      input.basePrice < 0
    ) {
      errors.push("ราคาแบบ Fixed ต้องเป็นตัวเลขไม่น้อยกว่า 0");
    }
  }
  if (
    input.urgentFeeDefault !== undefined &&
    (!Number.isFinite(input.urgentFeeDefault) || input.urgentFeeDefault < 0)
  ) {
    errors.push("urgent_fee_default ต้องไม่น้อยกว่า 0");
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

// ---------- Branch + technician assignment --------------------------------

export type BranchAssignmentInput = {
  /** branches.code (text slug). */
  orderBranchCode?: string | null;
  /** branches.id (uuid) of the technician's pinned branch. */
  technicianBranchId?: string | null;
  /** branches lookup table: { id (uuid): code (text) } */
  branchIdToCode?: Record<string, string>;
};

/**
 * Cross-branch check: order's branch_code must match the technician's
 * branch_id resolved to a code. Mirrors the DB trigger in 20260526.
 * Caller passes a `branchIdToCode` map (built from public.branches once
 * per page) so this stays pure.
 */
export function validateBranchAssignment(
  input: BranchAssignmentInput
): ValidationResult {
  if (!input.technicianBranchId) return { ok: true };
  if (!input.orderBranchCode) return { ok: true };
  const techBranchCode =
    input.branchIdToCode?.[input.technicianBranchId] ?? null;
  if (!techBranchCode) return { ok: true };
  if (techBranchCode === input.orderBranchCode) return { ok: true };
  return {
    ok: false,
    errors: [
      `ช่างสังกัดสาขา "${techBranchCode}" — มอบหมายให้ใบงานในสาขา "${input.orderBranchCode}" ไม่ได้`,
    ],
  };
}

export type TechnicianAssignmentInput = {
  active?: boolean;
};

export function validateTechnicianAssignment(
  input: TechnicianAssignmentInput
): ValidationResult {
  if (input.active === false) {
    return {
      ok: false,
      errors: ["ไม่สามารถมอบหมายงานให้ช่างที่ถูกปิดใช้งาน"],
    };
  }
  return { ok: true };
}

// ---------- Utilities -----------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime());
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
