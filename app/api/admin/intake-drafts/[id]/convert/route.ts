// POST /api/admin/intake-drafts/[id]/convert — owner/admin "Approve &
// Create Order" path. Thai user-facing strings in this file are written
// as UTF-8 (verify with `file route.ts` → "UTF-8 text"). If you see
// mojibake, your viewer is decoding UTF-8 as CP874 — switch it to UTF-8.
//
// Atomic-ish, idempotent, branch-isolated. The draft is the source for
// identity (customer, branch, photos, staff note, manual job code); the
// admin's request supplies only the catalog-confirmed service + qty +
// urgent toggle. Pricing comes from public.service_price_master via the
// pure quote engine in lib/servicePriceMaster.ts — NEVER from the request
// body. The body has no `price` field at all.
//
// Identity rule (Phase A):
//   • The new order's job_id is the draft's manual_job_code (the queue
//     number the staff wrote on the bag). The auto-generated draft_code
//     is a FALLBACK only — used and logged when manual_job_code is null
//     (legacy drafts created before the field existed).
//
// RBAC: owner / hq_admin / branch_manager. Branch-scoped roles can only
// convert drafts in their own branch.
//
// Idempotency: a draft whose converted_order_id is already set returns
// 200 with the existing orderId — the button is safe to retry.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveStaffActor } from "@/lib/staffActor";
import { canViewAllBranches } from "@/lib/permissions";
import {
  calculateServiceQuote,
  rowToServicePrice,
} from "@/lib/servicePriceMaster";
import { normalizeJobId } from "@/lib/jobId";
import { normalizePhone } from "@/lib/phone";
import {
  resolveBranchIdentity,
  BRANCH_NOT_FOUND_TH,
} from "@/lib/branchResolve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Roles allowed to convert a draft. Mirrors REVIEW_ROLES in the queue
 *  list route so a reviewer who can see a draft can also convert it. */
const CONVERT_ROLES = ["owner", "hq_admin", "branch_manager"] as const;

/** Same 45-day rolling window /api/orders/check-job-id (and the mobile
 *  draft create route) use. Mirrored here so the convert-time re-check
 *  is in lock-step with the rule staff already see at intake. */
const JOB_ID_DUPLICATE_WINDOW_DAYS = 45;

const DUPLICATE_JOB_CODE_TH =
  "รหัสรับงานนี้ถูกใช้แล้ว กรุณาตรวจสอบเลขคิวอีกครั้ง";

type Body = {
  serviceCode?: string;
  /** Defaults to the catalog row's default_qty when omitted / invalid. */
  qty?: number;
  /** Defaults to the draft's urgent_requested when omitted. */
  urgent?: boolean;
};

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const { id: draftId } = await params;
  if (!draftId) {
    return NextResponse.json(
      { ok: false, error: "draft id required" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "ไม่ได้ตั้งค่า service role" },
      { status: 503 }
    );
  }

  // ---- Auth + RBAC ------------------------------------------------------
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
  if (!(CONVERT_ROLES as readonly string[]).includes(actor.role)) {
    return NextResponse.json(
      {
        ok: false,
        error: "เฉพาะ Owner / Admin เท่านั้นที่อนุมัติสร้างงานได้",
      },
      { status: 403 }
    );
  }

  // ---- Body -------------------------------------------------------------
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 }
    );
  }
  const serviceCode = (body.serviceCode ?? "").trim();
  if (!serviceCode) {
    return NextResponse.json(
      { ok: false, error: "เลือกบริการจาก Pricing Master ก่อน (serviceCode)" },
      { status: 400 }
    );
  }

  // ---- Load draft -------------------------------------------------------
  const draftRes = await admin
    .from("intake_drafts")
    .select(
      "id, draft_code, manual_job_code, branch_id, customer_name, customer_phone, staff_note, urgent_requested, admin_review_note, status, converted_order_id, customer_id"
    )
    .eq("id", draftId)
    .maybeSingle();
  if (draftRes.error) {
    console.error("[intake-drafts/convert] load failed", draftRes.error);
    return NextResponse.json(
      { ok: false, error: draftRes.error.message },
      { status: 500 }
    );
  }
  if (!draftRes.data) {
    return NextResponse.json(
      { ok: false, error: "ไม่พบ draft นี้" },
      { status: 404 }
    );
  }
  const draft = draftRes.data as {
    id: string;
    draft_code: string;
    manual_job_code: string | null;
    branch_id: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    staff_note: string | null;
    urgent_requested: boolean | null;
    admin_review_note: string | null;
    status: string;
    converted_order_id: string | null;
    customer_id: string | null;
  };

  // Branch isolation — a branch-scoped role only on its own branch.
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

  // ---- Resolve branch identity ---------------------------------------
  // intake_drafts.branch_id stores the slug (e.g. "c24-thonburi-market")
  // because the mobile UI carries the slug everywhere. customers.branch_id
  // is uuid (verified against app/customers/page.tsx), so we MUST resolve
  // the slug to branches.id before the customer insert. orders.branch_id
  // is text slug system-wide (see createSmartOrder) — pass `code` there.
  // A missing/unknown branch is a 400 with the standard Thai message.
  const branchIdentity = draft.branch_id
    ? await resolveBranchIdentity(admin, draft.branch_id)
    : null;
  if (draft.branch_id && !branchIdentity) {
    return NextResponse.json(
      { ok: false, error: BRANCH_NOT_FOUND_TH },
      { status: 400 }
    );
  }

  // Idempotent: a converted draft just echoes the existing order id.
  if (draft.converted_order_id) {
    return NextResponse.json({
      ok: true,
      idempotent: true,
      orderId: draft.converted_order_id,
      jobId: draft.manual_job_code ?? draft.draft_code,
    });
  }
  if (draft.status === "CANCELLED") {
    return NextResponse.json(
      { ok: false, error: "draft นี้ถูกยกเลิกแล้ว ไม่สามารถสร้างงานได้" },
      { status: 409 }
    );
  }

  // ---- Resolve the carried job id (manual is the source of truth) ------
  let jobId = normalizeJobId(draft.manual_job_code);
  let jobIdFallback = false;
  if (!jobId) {
    // Legacy draft (created before manual_job_code existed). Fall back to
    // the system-internal draft_code so the order still has a job_id, and
    // log loudly so this is easy to spot.
    jobId = normalizeJobId(draft.draft_code);
    jobIdFallback = true;
    console.warn(
      "[intake-drafts/convert] manual_job_code missing — falling back to draft_code",
      { draftId, draftCode: draft.draft_code }
    );
  }
  if (!jobId) {
    return NextResponse.json(
      {
        ok: false,
        error: "draft นี้ไม่มีรหัสรับงาน กรุณาสร้างงานผ่าน /intake แทน",
      },
      { status: 400 }
    );
  }

  // ---- Convert-time duplicate re-check (race protection) ---------------
  // The draft create route already probed; that was minutes/hours ago.
  // Between then and now an /intake save could have grabbed the same
  // (branch_id, job_id) within the 45-day window. Re-check here against
  // public.orders (the only table whose job_id we're about to claim).
  // A genuine lookup failure is NEVER reported as duplicate — same rule
  // /api/orders/check-job-id uses.
  if (draft.branch_id) {
    const windowStart = new Date(
      Date.now() - JOB_ID_DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const orderDup = await admin
      .from("orders")
      .select("id", { head: true, count: "exact" })
      .eq("branch_id", draft.branch_id)
      .eq("job_id", jobId)
      .gte("created_at", windowStart);
    if (orderDup.error) {
      console.error(
        "[intake-drafts/convert] order dup re-probe failed",
        {
          message: orderDup.error.message,
          code: orderDup.error.code,
          branchId: draft.branch_id,
          jobId,
        }
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
    // Also re-check intake_drafts for another non-cancelled, non-converted
    // draft holding the same code in this branch — covers the case where
    // a second mobile submit landed during admin review.
    const draftDup = await admin
      .from("intake_drafts")
      .select("id", { head: true, count: "exact" })
      .eq("branch_id", draft.branch_id)
      .eq("manual_job_code", jobId)
      .neq("status", "CANCELLED")
      .neq("status", "CONVERTED_TO_ORDER")
      .neq("id", draftId);
    if (draftDup.error) {
      console.error(
        "[intake-drafts/convert] draft dup re-probe failed",
        {
          message: draftDup.error.message,
          code: draftDup.error.code,
          branchId: draft.branch_id,
          jobId,
        }
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
  }

  // ---- Pricing Master is the only source of truth for price -----------
  const svcRes = await admin
    .from("service_price_master")
    .select("*")
    .eq("service_code", serviceCode)
    .eq("active", true)
    .maybeSingle();
  if (svcRes.error) {
    console.error("[intake-drafts/convert] service lookup failed", svcRes.error);
    return NextResponse.json(
      { ok: false, error: svcRes.error.message },
      { status: 500 }
    );
  }
  if (!svcRes.data) {
    return NextResponse.json(
      {
        ok: false,
        error: `ไม่พบราคาบริการใน Pricing Master (${serviceCode})`,
      },
      { status: 404 }
    );
  }
  const service = rowToServicePrice(
    svcRes.data as Record<string, unknown>
  );

  const requestedQty =
    typeof body.qty === "number" && Number.isFinite(body.qty) && body.qty > 0
      ? body.qty
      : service.defaultQty || 1;
  const urgentFinal =
    typeof body.urgent === "boolean"
      ? body.urgent
      : draft.urgent_requested === true;

  const quote = calculateServiceQuote(service, requestedQty, urgentFinal);
  // AUTO_QUOTE returns a real total. GUIDED/MANUAL needs a human-confirmed
  // price — the convert flow is for ready-to-create work; the reviewer
  // should use /intake?draftId=… for those.
  if (quote.total === null) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "บริการนี้ต้องตอบคำถามแนะนำ หรือประเมินโดยช่างก่อน กรุณาเปิด /intake เพื่อทำมือแทน",
      },
      { status: 422 }
    );
  }

  const total = quote.total;
  const subtotal = quote.lines
    .filter((l) => l.kind === "service")
    .reduce((sum, l) => sum + l.amount, 0);
  const urgentFee = quote.urgentApplied ? quote.urgentFee : 0;
  const customerName = (draft.customer_name ?? "").trim() || "(ไม่ระบุชื่อ)";
  // Two faces of the same branch — see lib/branchResolve.ts for the why.
  //   branchSlug = orders.branch_id (text)
  //   branchUuid = customers.branch_id (uuid)
  const branchSlug = branchIdentity?.code ?? null;
  const branchUuid = branchIdentity?.uuid ?? null;

  // ---- Find or create customer (inline; no project helper exists) -----
  // customers.branch_id is uuid — we MUST pass branchUuid here, never the
  // slug. This is the exact bug that surfaced as
  //   "invalid input syntax for type uuid: \"c24-thonburi-market\""
  let customerId: string | null = draft.customer_id;
  const phoneNormalized = normalizePhone(draft.customer_phone);
  if (!customerId && phoneNormalized && branchUuid) {
    const existing = await admin
      .from("customers")
      .select("id")
      .eq("normalized_phone", phoneNormalized)
      .eq("branch_id", branchUuid)
      .limit(1)
      .maybeSingle();
    if (existing.error) {
      console.warn(
        "[intake-drafts/convert] customer lookup failed (continuing)",
        existing.error.message
      );
    }
    if (existing.data) {
      customerId = String((existing.data as { id: string }).id);
    } else {
      const cIns = await admin
        .from("customers")
        .insert({
          name: customerName,
          phone: draft.customer_phone,
          normalized_phone: phoneNormalized,
          branch_id: branchUuid,
        })
        .select("id")
        .single();
      if (cIns.error) {
        console.error(
          "[intake-drafts/convert] customer create failed",
          cIns.error
        );
        return NextResponse.json(
          { ok: false, error: `สร้างข้อมูลลูกค้าไม่สำเร็จ: ${cIns.error.message}` },
          { status: 500 }
        );
      }
      customerId = String((cIns.data as { id: string }).id);
    }
  }

  // ---- Insert order (latest schema; matches createSmartOrder v4) ------
  const combinedNote = [
    draft.staff_note ? `[หน้าร้าน] ${draft.staff_note}` : null,
    draft.admin_review_note ? `[แอดมิน] ${draft.admin_review_note}` : null,
    jobIdFallback
      ? `[fallback] manual_job_code missing — used draft_code ${draft.draft_code}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const orderInsert = {
    // legacy v1
    customer_id: customerId,
    customer_name: customerName,
    item_name: service.serviceNameTh,
    price: total,
    status: "pending",
    // v2 — intake extension. orders.branch_id stores the slug.
    branch_id: branchSlug,
    urgent: urgentFinal,
    urgent_fee: urgentFee,
    notes: combinedNote || null,
    // v3 — smart order
    subtotal,
    discount: 0,
    service_category: service.categoryTh ?? null,
    service_code: service.serviceCode,
    service_name: service.serviceNameTh,
    quantity: requestedQty,
    template_text: null,
    customer_type: null,
    promotion_code: null,
    payment_status: "unpaid",
    document_type: "intake_quote_receipt",
    // v4 — auth/audit
    job_id: jobId,
    created_by: actor.uid,
    business_type: "care_u",
    due_date: null,
    tech: null,
  };

  const orderRes = await admin
    .from("orders")
    .insert(orderInsert)
    .select("id")
    .single();
  if (orderRes.error) {
    console.error("[intake-drafts/convert] order insert failed", {
      message: orderRes.error.message,
      code: orderRes.error.code,
      details: orderRes.error.details,
    });
    return NextResponse.json(
      { ok: false, error: `สร้างงานไม่สำเร็จ: ${orderRes.error.message}` },
      { status: 500 }
    );
  }
  const orderId = String((orderRes.data as { id: string }).id);

  // ---- Insert order item (one line; multi-item flow stays on /intake) -
  // order_items.branch_id mirrors orders.branch_id — text slug, not uuid.
  const itemInsert = {
    order_id: orderId,
    branch_id: branchSlug,
    line_no: 1,
    category: service.categoryTh ?? null,
    service_code: service.serviceCode,
    service_name: service.serviceNameTh,
    detail: null,
    quantity: requestedQty,
    unit_price: service.basePrice ?? 0,
    urgent: urgentFinal,
    urgent_fee: urgentFee,
    line_total: total,
    due_date: null,
    assigned_technician_id: null,
    technician_note: null,
    customer_note: null,
    // No order_attachments migration in this phase — image_paths on the
    // item carries the draft photos forward, mirroring /intake's behavior.
    image_paths: [] as string[],
  };
  // Best-effort include of draft image paths in image_paths.
  const mediaRes = await admin
    .from("intake_draft_media")
    .select("file_url, media_type")
    .eq("draft_id", draftId)
    .eq("media_type", "image");
  if (!mediaRes.error && Array.isArray(mediaRes.data)) {
    itemInsert.image_paths = (
      mediaRes.data as Array<{ file_url: string | null }>
    )
      .map((r) => (r.file_url ?? "").trim())
      .filter((p): p is string => p.length > 0);
  }

  const itemRes = await admin.from("order_items").insert(itemInsert);
  if (itemRes.error) {
    // The header order saved — don't roll back; report so the admin can
    // add items by hand on the order page. order_items rows cascade with
    // the order, so a half-saved order is consistent.
    console.error("[intake-drafts/convert] item insert failed", itemRes.error);
  }

  // ---- Audit log (best effort) ----------------------------------------
  await admin
    .from("order_audit_log")
    .insert({
      order_id: orderId,
      action: "created",
      after_value: jobId,
      changed_by: actor.uid,
      note: `from intake_draft ${draft.draft_code}`,
    })
    .then((r) => {
      if (r.error) {
        console.warn(
          "[intake-drafts/convert] audit write failed",
          r.error.message
        );
      }
    });

  // ---- Mark the draft converted (last so a failed convert leaves the
  //      draft re-runnable). ------------------------------------------
  const upd = await admin
    .from("intake_drafts")
    .update({
      status: "CONVERTED_TO_ORDER",
      converted_order_id: orderId,
      customer_id: customerId,
      approved_price: total,
    })
    .eq("id", draftId);
  if (upd.error) {
    // Order is real and saved; just log. The reviewer can flip the draft
    // status from the queue if this update lags.
    console.error(
      "[intake-drafts/convert] draft mark-converted failed",
      upd.error
    );
  }

  console.log("[intake-drafts/convert] success", {
    draftId,
    orderId,
    jobId,
    serviceCode: service.serviceCode,
    total,
    actor: actor.uid,
  });

  return NextResponse.json({
    ok: true,
    orderId,
    jobId,
    total,
    itemSaveError: itemRes.error?.message ?? null,
  });
}
