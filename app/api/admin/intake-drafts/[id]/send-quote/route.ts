// POST /api/admin/intake-drafts/[id]/send-quote — Phase C / L8.
//
// Sends the customer a Flex "ใบเสนอราคา" (quote summary) on LINE — service,
// branch, price, validity — per architecture doc §10.6.
//
// F1 / F3 guard: the AI never prices. The `price` in the body is a number
// the Owner/Admin typed and reviewed on /admin/intake-drafts. This route is
// triggered by an explicit admin button press and sends exactly that quote.
// It never converts a draft, never writes pricing-master columns.
//
// LINE userId source: recovered from the draft's staff_note (the care-u
// bot records it there) via lib/lineReplyDraft — no DB column, no migration.
//
// Outbound audit: every attempt appends to public.line_message_log with
// kind='manual' (best-effort — a failed log never fails the send).
//
// RBAC: owner / hq_admin / branch_manager via resolveStaffActor, with the
// same branch isolation as the classify / send-line-reply routes.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveStaffActor } from "@/lib/staffActor";
import { canViewAllBranches } from "@/lib/permissions";
import { resolveLineChannelConfig } from "@/lib/lineConfig";
import { pushMessages } from "@/lib/lineMessaging";
import { extractLineUserId } from "@/lib/lineReplyDraft";
import { buildQuoteFlex, validateQuoteFlexInput } from "@/lib/lineQuoteFlex";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const QUOTE_ROLES = ["owner", "hq_admin", "branch_manager"] as const;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const { id: draftId } = await params;
  if (!draftId) {
    return NextResponse.json(
      { ok: false, reason: "draft id required" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "ไม่ได้ตั้งค่า service role" },
      { status: 503 }
    );
  }

  const actor = await resolveStaffActor(
    admin,
    req.headers.get("x-careu-staff-id")
  );
  if (!actor) {
    return NextResponse.json(
      { ok: false, reason: "ต้องเข้าสู่ระบบก่อน" },
      { status: 401 }
    );
  }
  if (!(QUOTE_ROLES as readonly string[]).includes(actor.role)) {
    return NextResponse.json(
      { ok: false, reason: "เฉพาะ Owner / Admin เท่านั้นที่ส่งใบเสนอราคาได้" },
      { status: 403 }
    );
  }

  // ---- Body: the admin-reviewed quote ----------------------------------
  let body: {
    price?: unknown;
    serviceText?: unknown;
    shopName?: unknown;
    branchText?: unknown;
    validityText?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "รูปแบบคำขอไม่ถูกต้อง" },
      { status: 400 }
    );
  }
  const price =
    typeof body.price === "number"
      ? body.price
      : typeof body.price === "string"
        ? Number(body.price)
        : NaN;
  const serviceText =
    typeof body.serviceText === "string" ? body.serviceText.trim() : "";
  const shopName =
    typeof body.shopName === "string" && body.shopName.trim().length > 0
      ? body.shopName.trim()
      : "Care U";
  const validityText =
    typeof body.validityText === "string" ? body.validityText.trim() : "";

  // ---- Load the draft ---------------------------------------------------
  const draftRes = await admin
    .from("intake_drafts")
    .select(
      "id, branch_id, staff_note, intake_source, customer_id, manual_job_code"
    )
    .eq("id", draftId)
    .maybeSingle();
  if (draftRes.error) {
    console.error("[intake-drafts/send-quote] load failed", draftRes.error);
    return NextResponse.json(
      { ok: false, reason: draftRes.error.message },
      { status: 500 }
    );
  }
  if (!draftRes.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบ draft นี้" },
      { status: 404 }
    );
  }
  const draft = draftRes.data as {
    id: string;
    branch_id: string | null;
    staff_note: string | null;
    intake_source: string | null;
    customer_id: string | null;
    manual_job_code: string | null;
  };

  // Branch isolation — same rule as the classify / send-line-reply routes.
  if (
    !canViewAllBranches(actor.role) &&
    actor.branchId &&
    draft.branch_id &&
    draft.branch_id !== actor.branchId
  ) {
    return NextResponse.json(
      { ok: false, reason: "draft อยู่คนละสาขา" },
      { status: 403 }
    );
  }

  // ---- Build + validate the quote Flex ---------------------------------
  const quoteInput = {
    shopName,
    serviceText,
    price,
    branchText:
      typeof body.branchText === "string" && body.branchText.trim().length > 0
        ? body.branchText.trim()
        : draft.branch_id,
    jobCode: draft.manual_job_code,
    validityText: validityText.length > 0 ? validityText : null,
    approvedByText: "เจ้าของร้าน",
  };
  const valid = validateQuoteFlexInput(quoteInput);
  if (!valid.ok) {
    return NextResponse.json(
      { ok: false, reason: valid.reason },
      { status: 400 }
    );
  }

  // ---- Resolve the customer's LINE userId ------------------------------
  const lineUserId = extractLineUserId(draft.staff_note);
  if (!lineUserId) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "draft นี้ไม่มี LINE userId — ส่งใบเสนอราคาทาง LINE ไม่ได้ (draft อาจไม่ได้มาจาก LINE OA)",
      },
      { status: 200 }
    );
  }

  // ---- Resolve the LINE channel ----------------------------------------
  const config = await resolveLineChannelConfig(draft.branch_id);
  if (!config) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "ยังไม่ได้ตั้งค่า LINE OA ใน careu-platform — ต้องตั้ง LINE_CHANNEL_ACCESS_TOKEN ก่อน",
      },
      { status: 200 }
    );
  }

  // ---- Build + push -----------------------------------------------------
  const flex = buildQuoteFlex(quoteInput);
  const result = await pushMessages(config, lineUserId, [flex]);

  // ---- Audit (best-effort) ---------------------------------------------
  try {
    await admin.from("line_message_log").insert({
      customer_id: draft.customer_id ?? null,
      order_id: null,
      branch_id: draft.branch_id ?? null,
      line_user_id: lineUserId,
      kind: "manual",
      message_text: flex.altText,
      payload: {
        source: "intake-drafts/send-quote",
        draft_id: draftId,
        intake_source: draft.intake_source,
        actor: actor.uid,
        quote_price: price,
        quote_service: serviceText,
        line_request_id: result.ok ? result.requestId : null,
      },
      status: result.ok ? "sent" : "failed",
      error_reason: result.ok ? null : result.reason,
      attempts: 1,
      sent_at: result.ok ? new Date().toISOString() : null,
    });
  } catch (err) {
    console.warn(
      "[intake-drafts/send-quote] audit log insert failed (non-fatal)",
      err
    );
  }

  console.log("[intake-drafts/send-quote] done", {
    draftId,
    actor: actor.uid,
    sent: result.ok,
    price,
    reason: result.ok ? null : result.reason,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, reason: "ส่งใบเสนอราคาไม่สำเร็จ: " + result.reason },
      { status: 200 }
    );
  }

  return NextResponse.json({
    ok: true,
    requestId: result.requestId,
    channelOrigin: config.origin,
  });
}
