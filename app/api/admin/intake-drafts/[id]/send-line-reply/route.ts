// POST /api/admin/intake-drafts/[id]/send-line-reply — Phase C / L7.
//
// Lets an Owner/Admin reply to the customer's LINE from the
// /admin/intake-drafts review page — typically the L6 Guided Question
// Engine's drafted questions, edited by the admin first.
//
// F3 guard: the AI only DRAFTS the questions. This route is triggered by
// a human button press and sends exactly the text the admin submitted.
// It never prices, never converts, never auto-replies.
//
// This route NEVER:
//   - converts a draft to an order
//   - touches orders / customers / pricing columns
//   - sends without an explicit admin request
//
// LINE userId source: the care-u-line-oa bot records the customer's LINE
// userId inside the draft's staff_note ("LINE userId: U…"). lib/lineReplyDraft
// recovers it — no DB column, no migration (F4 / F7).
//
// Outbound audit: every attempt is appended to public.line_message_log
// with kind='manual' (best-effort — a failed log never fails the send).
//
// RBAC: owner / hq_admin / branch_manager via resolveStaffActor, with the
// same branch isolation as the classify + convert routes.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveStaffActor } from "@/lib/staffActor";
import { canViewAllBranches } from "@/lib/permissions";
import { resolveLineChannelConfig } from "@/lib/lineConfig";
import { pushTextMessage } from "@/lib/lineMessaging";
import { extractLineUserId, validateReplyText } from "@/lib/lineReplyDraft";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPLY_ROLES = ["owner", "hq_admin", "branch_manager"] as const;

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
  if (!(REPLY_ROLES as readonly string[]).includes(actor.role)) {
    return NextResponse.json(
      { ok: false, reason: "เฉพาะ Owner / Admin เท่านั้นที่ตอบ LINE ได้" },
      { status: 403 }
    );
  }

  // ---- Body: the admin-reviewed reply text ------------------------------
  let body: { text?: unknown };
  try {
    body = (await req.json()) as { text?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "รูปแบบคำขอไม่ถูกต้อง" },
      { status: 400 }
    );
  }
  const textCheck = validateReplyText(
    typeof body.text === "string" ? body.text : ""
  );
  if (!textCheck.ok) {
    return NextResponse.json(
      { ok: false, reason: textCheck.reason },
      { status: 400 }
    );
  }
  const text = textCheck.text;

  // ---- Load the draft ---------------------------------------------------
  const draftRes = await admin
    .from("intake_drafts")
    .select(
      "id, branch_id, staff_note, intake_source, customer_id, customer_name"
    )
    .eq("id", draftId)
    .maybeSingle();
  if (draftRes.error) {
    console.error("[intake-drafts/send-line-reply] load failed", draftRes.error);
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
    customer_name: string | null;
  };

  // Branch isolation — same rule as the classify + convert routes.
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

  // ---- Resolve the customer's LINE userId -------------------------------
  // A line_oa draft carries it in staff_note; a mobile/website draft does
  // not — there is no LINE thread to reply to. Recoverable → 200 ok:false.
  const lineUserId = extractLineUserId(draft.staff_note);
  if (!lineUserId) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "draft นี้ไม่มี LINE userId — ตอบกลับทาง LINE ไม่ได้ (draft อาจไม่ได้มาจาก LINE OA)",
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
          "ยังไม่ได้ตั้งค่า LINE OA ใน careu-platform — ต้องตั้ง LINE_CHANNEL_ACCESS_TOKEN ของ Care U ก่อน",
      },
      { status: 200 }
    );
  }

  // ---- Push the message -------------------------------------------------
  const result = await pushTextMessage(config, lineUserId, text);

  // ---- Audit: append to public.line_message_log (best-effort) ----------
  // The service-role client is allowed to INSERT here. A failed audit
  // write must never fail a successful customer send.
  try {
    await admin.from("line_message_log").insert({
      customer_id: draft.customer_id ?? null,
      order_id: null,
      branch_id: draft.branch_id ?? null,
      line_user_id: lineUserId,
      kind: "manual",
      message_text: text,
      payload: {
        source: "intake-drafts/send-line-reply",
        draft_id: draftId,
        intake_source: draft.intake_source,
        actor: actor.uid,
        line_request_id: result.ok ? result.requestId : null,
      },
      status: result.ok ? "sent" : "failed",
      error_reason: result.ok ? null : result.reason,
      attempts: 1,
      sent_at: result.ok ? new Date().toISOString() : null,
    });
  } catch (err) {
    console.warn(
      "[intake-drafts/send-line-reply] audit log insert failed (non-fatal)",
      err
    );
  }

  console.log("[intake-drafts/send-line-reply] done", {
    draftId,
    actor: actor.uid,
    sent: result.ok,
    chars: text.length,
    reason: result.ok ? null : result.reason,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason: "ส่ง LINE ไม่สำเร็จ: " + result.reason,
      },
      { status: 200 }
    );
  }

  return NextResponse.json({
    ok: true,
    requestId: result.requestId,
    channelOrigin: config.origin,
  });
}
