// POST /api/admin/intake-drafts/update - owner/admin updates one draft.
//
// Two responsibilities, both narrow:
//   1. Workflow plumbing: status, admin_review_note, converted_order_id
//      (the last is set by the convert route, but a manual fix-up path
//      remains useful for ops).
//   2. Phase B owner-confirmation: confirmed_garment_type,
//      confirmed_repair_category, confirmed_repair_area,
//      confirmed_difficulty, confirmed_price, review_status. Setting
//      review_status = "reviewed" stamps reviewed_by / reviewed_at
//      from the actor; the client never supplies those.
//
// This route NEVER:
//   - touches orders, customers, payment_status, document_type, or
//     pricing-master columns
//   - writes ai_* fields (those are owned by /classify)
//   - converts a draft to an order

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveStaffActor } from "@/lib/staffActor";
import { canViewAllBranches } from "@/lib/permissions";
import { isDraftStatus, isReviewStatus } from "@/lib/intakeDrafts";
import { normalizeJobId } from "@/lib/jobId";

/** Same 45-day rolling window /api/mobile-intake/draft + /convert use.
 *  Mirrored here so the owner can't type a code that the intake form
 *  would still flag as duplicate. */
const JOB_ID_DUPLICATE_WINDOW_DAYS = 45;

const DUPLICATE_JOB_CODE_TH =
  "รหัสรับงานนี้ถูกใช้แล้ว กรุณาตรวจสอบเลขคิวอีกครั้ง";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REVIEW_ROLES = ["owner", "hq_admin", "branch_manager"] as const;

type Body = {
  draftId?: string;
  status?: string;
  adminReviewNote?: string;
  convertedOrderId?: string | null;
  // Phase B owner-confirmation fields
  confirmedGarmentType?: string | null;
  confirmedRepairCategory?: string | null;
  confirmedRepairArea?: string | null;
  confirmedDifficulty?: string | null;
  confirmedPrice?: number | null;
  reviewStatus?: string;
  // Phase W2 - owner attaches the real bag-tag code to a website-sourced
  // draft. Branch-scoped duplicate check mirrors /api/mobile-intake/draft.
  manualJobCode?: string | null;
};

function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  return v === "" ? null : v;
}

function cleanNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // Reject negative prices outright so a bad UI never persists one.
  if (value < 0) return null;
  return Math.round(value * 100) / 100;
}

export async function POST(req: Request) {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "ไม่ได้ตั้งค่า service role" },
      { status: 503 }
    );
  }

  const actor = await resolveStaffActor(
    admin,
    req.headers.get("x-careu-staff-id")
  );
  if (!actor) {
    return NextResponse.json(
      { ok: false, error: "ต้องเข้าสู่ระบบก่อน" },
      { status: 401 }
    );
  }
  if (!(REVIEW_ROLES as readonly string[]).includes(actor.role)) {
    return NextResponse.json(
      { ok: false, error: "ไม่มีสิทธิ์แก้ไขคิวงาน" },
      { status: 403 }
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 }
    );
  }

  const draftId = (body.draftId ?? "").trim();
  if (!draftId) {
    return NextResponse.json(
      { ok: false, error: "draftId required" },
      { status: 400 }
    );
  }

  // Load the existing draft for branch-isolation + idempotency checks.
  const existing = await admin
    .from("intake_drafts")
    .select("id, branch_id, converted_order_id, manual_job_code")
    .eq("id", draftId)
    .maybeSingle();
  if (existing.error) {
    console.error("[intake-drafts/update] load failed", existing.error);
    return NextResponse.json(
      { ok: false, error: existing.error.message },
      { status: 500 }
    );
  }
  if (!existing.data) {
    return NextResponse.json(
      { ok: false, error: "ไม่พบ draft นี้" },
      { status: 404 }
    );
  }
  const draft = existing.data as {
    id: string;
    branch_id: string | null;
    converted_order_id: string | null;
    manual_job_code: string | null;
  };

  if (
    !canViewAllBranches(actor.role) &&
    actor.branchId &&
    draft.branch_id &&
    draft.branch_id !== actor.branchId
  ) {
    return NextResponse.json(
      { ok: false, error: "draft อยู่คนละสาขา" },
      { status: 403 }
    );
  }

  // status=CONVERTED_TO_ORDER is still accepted here because
  // /intake?draftId=... posts it from its onCreated callback after a
  // manual /intake save. We only require convertedOrderId to ride along,
  // so a "converted" draft can never exist without a real orders row.
  if (
    body.status === "CONVERTED_TO_ORDER" &&
    !cleanText(body.convertedOrderId) &&
    !draft.converted_order_id
  ) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "ตั้ง CONVERTED_TO_ORDER ต้องส่ง convertedOrderId มาด้วย หรือใช้ปุ่มอนุมัติแทน",
      },
      { status: 400 }
    );
  }

  const patch: Record<string, unknown> = {};

  if (body.status !== undefined) {
    if (!isDraftStatus(body.status)) {
      return NextResponse.json(
        { ok: false, error: `สถานะ "${body.status}" ไม่ถูกต้อง` },
        { status: 400 }
      );
    }
    patch.status = body.status;
  }
  if (body.adminReviewNote !== undefined) {
    patch.admin_review_note = cleanText(body.adminReviewNote);
  }
  if (body.convertedOrderId !== undefined) {
    patch.converted_order_id = cleanText(body.convertedOrderId);
  }

  // ---- Phase B owner-confirmation fields ------------------------------
  if (body.confirmedGarmentType !== undefined) {
    patch.confirmed_garment_type = cleanText(body.confirmedGarmentType);
  }
  if (body.confirmedRepairCategory !== undefined) {
    patch.confirmed_repair_category = cleanText(body.confirmedRepairCategory);
  }
  if (body.confirmedRepairArea !== undefined) {
    patch.confirmed_repair_area = cleanText(body.confirmedRepairArea);
  }
  if (body.confirmedDifficulty !== undefined) {
    patch.confirmed_difficulty = cleanText(body.confirmedDifficulty);
  }
  if (body.confirmedPrice !== undefined) {
    patch.confirmed_price = cleanNumber(body.confirmedPrice);
  }
  // ---- Phase W2: owner attaches the bag-tag code ---------------------
  if (body.manualJobCode !== undefined) {
    const raw = body.manualJobCode;
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
      // Allow clearing (rare, but harmless). The convert route falls
      // back to draft_code when manual_job_code is null.
      patch.manual_job_code = null;
    } else {
      const normalized = normalizeJobId(raw);
      if (!normalized) {
        return NextResponse.json(
          {
            ok: false,
            error: "รหัสรับงานไม่ถูกต้อง (ใช้ได้ A-Z 0-9 - _ . / ความยาวสูงสุด 32)",
          },
          { status: 400 }
        );
      }
      // Branch-scoped duplicate probes - mirrors /api/mobile-intake/draft
      // so the owner can't pick a code that the intake form would flag.
      // Skip when the new value equals the current value (no-op edit).
      if (
        normalized !== (draft.manual_job_code ?? null) &&
        draft.branch_id
      ) {
        const draftDup = await admin
          .from("intake_drafts")
          .select("id", { head: true, count: "exact" })
          .eq("branch_id", draft.branch_id)
          .eq("manual_job_code", normalized)
          .neq("status", "CANCELLED")
          .neq("id", draftId);
        if (draftDup.error) {
          console.error(
            "[intake-drafts/update] manualJobCode draft dup probe failed",
            draftDup.error
          );
          return NextResponse.json(
            { ok: false, error: "ตรวจสอบรหัสซ้ำไม่สำเร็จ ลองอีกครั้ง" },
            { status: 500 }
          );
        }
        if ((draftDup.count ?? 0) > 0) {
          return NextResponse.json(
            { ok: false, error: DUPLICATE_JOB_CODE_TH, state: "duplicate" },
            { status: 409 }
          );
        }
        const windowStart = new Date(
          Date.now() - JOB_ID_DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000
        ).toISOString();
        const orderDup = await admin
          .from("orders")
          .select("id", { head: true, count: "exact" })
          .eq("branch_id", draft.branch_id)
          .eq("job_id", normalized)
          .gte("created_at", windowStart);
        if (orderDup.error) {
          console.error(
            "[intake-drafts/update] manualJobCode order dup probe failed",
            orderDup.error
          );
          return NextResponse.json(
            { ok: false, error: "ตรวจสอบรหัสซ้ำไม่สำเร็จ ลองอีกครั้ง" },
            { status: 500 }
          );
        }
        if ((orderDup.count ?? 0) > 0) {
          return NextResponse.json(
            { ok: false, error: DUPLICATE_JOB_CODE_TH, state: "duplicate" },
            { status: 409 }
          );
        }
      }
      patch.manual_job_code = normalized;
    }
  }

  if (body.reviewStatus !== undefined) {
    if (!isReviewStatus(body.reviewStatus)) {
      return NextResponse.json(
        { ok: false, error: `review status "${body.reviewStatus}" ไม่ถูกต้อง` },
        { status: 400 }
      );
    }
    // "converted" is owned by the convert route; refuse to set it here.
    if (body.reviewStatus === "converted") {
      return NextResponse.json(
        {
          ok: false,
          error: "review_status='converted' ตั้งเองไม่ได้ ใช้ปุ่มอนุมัติแทน",
        },
        { status: 400 }
      );
    }
    patch.review_status = body.reviewStatus;
    if (body.reviewStatus === "reviewed") {
      // Stamp the reviewer + timestamp on the server so the client can't
      // forge them. reviewed_by is text (no FK) since the staff actor
      // may not have a profiles row in cookieless mode.
      patch.reviewed_by = actor.uid;
      patch.reviewed_at = new Date().toISOString();
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { ok: false, error: "ไม่มีข้อมูลที่จะอัปเดต" },
      { status: 400 }
    );
  }

  const res = await admin
    .from("intake_drafts")
    .update(patch)
    .eq("id", draftId)
    .select("id")
    .maybeSingle();
  if (res.error) {
    console.error("[intake-drafts/update] failed", res.error);
    return NextResponse.json(
      { ok: false, error: res.error.message },
      { status: 500 }
    );
  }
  if (!res.data) {
    return NextResponse.json(
      { ok: false, error: "ไม่พบ draft นี้" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}
