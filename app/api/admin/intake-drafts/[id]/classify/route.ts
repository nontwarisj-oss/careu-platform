// POST /api/admin/intake-drafts/[id]/classify - Phase B foundation.
//
// Pure server-side classifier. Runs the rule engine in
// lib/intakeClassifier.ts against the draft's staff_note + manual code,
// writes the suggestion into the ai_* columns, leaves needs_human_review
// = true. The owner must still confirm via /api/admin/intake-drafts/update
// before the draft is considered reviewed.
//
// This route NEVER:
//   - converts a draft to an order
//   - touches orders, customers, payment_status, document_type, or any
//     pricing-master column
//   - writes confirmed_* fields (those are owner-only via /update)
//
// RBAC: owner / hq_admin / branch_manager via resolveStaffActor. Branch
// isolation mirrors the convert route. The classifier itself is pure
// and stateless; the only DB writes are to the draft row.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveStaffActor } from "@/lib/staffActor";
import { canViewAllBranches } from "@/lib/permissions";
import { classifyIntake } from "@/lib/intakeClassifier";
import { routeService } from "@/lib/serviceRouter";
import {
  buildChecklist,
  renderAdminChecklist,
} from "@/lib/guidedQuestionEngine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CLASSIFY_ROLES = ["owner", "hq_admin", "branch_manager"] as const;

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
  if (!(CLASSIFY_ROLES as readonly string[]).includes(actor.role)) {
    return NextResponse.json(
      {
        ok: false,
        error: "เฉพาะ Owner / Admin เท่านั้นที่วิเคราะห์งานได้",
      },
      { status: 403 }
    );
  }

  // Load the draft. Only the columns the classifier consumes.
  const draftRes = await admin
    .from("intake_drafts")
    .select(
      "id, branch_id, staff_note, manual_job_code, urgent_requested, converted_order_id"
    )
    .eq("id", draftId)
    .maybeSingle();
  if (draftRes.error) {
    console.error("[intake-drafts/classify] load failed", draftRes.error);
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
    branch_id: string | null;
    staff_note: string | null;
    manual_job_code: string | null;
    urgent_requested: boolean | null;
    converted_order_id: string | null;
  };

  // Branch isolation - same rule as the convert + list routes.
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

  // Refuse to re-classify after convert - the AI block on a real order
  // would mislead. The /update route can still edit confirmed_* on a
  // converted draft for after-the-fact audit, but re-classify is off.
  if (draft.converted_order_id) {
    return NextResponse.json(
      {
        ok: false,
        error: "draft นี้ถูกแปลงเป็น Order แล้ว ไม่สามารถวิเคราะห์ซ้ำได้",
      },
      { status: 409 }
    );
  }

  // ---- Run the classifier (pure) ---------------------------------------
  const suggestion = classifyIntake({
    staffNote: draft.staff_note,
    manualJobCode: draft.manual_job_code,
    urgentRequested: draft.urgent_requested === true,
  });

  // Round confidence to 2dp for storage (ai_confidence is numeric(5,2)).
  const confidence2dp = Math.round(suggestion.confidence * 100) / 100;

  // ---- L5: AI Service Router (7-domain) — ADDITIVE to Phase B ----------
  // Phase B's classifyIntake covers clothing-repair sub-categories only.
  // The Router classifies the draft into one of the 7 service domains and
  // writes the result into the *separate* ai_suggested_* columns, so a
  // non-clothing draft (shoe / watch / luggage / car key) still gets a
  // correct domain suggestion. Text-only for now; the bot's vision labels
  // can be fed in as an extra signal in a later step. AI suggests only —
  // a human still confirms in /admin/intake-drafts (F3).
  const route = routeService({ text: draft.staff_note });

  // ---- L6: Guided Question Engine — missing-info checklist ------------
  // Count photos already on the draft so the checklist "have" summary is
  // accurate. Best-effort: a failed count just yields photoCount 0.
  let photoCount = 0;
  const mediaCountRes = await admin
    .from("intake_draft_media")
    .select("id", { count: "exact", head: true })
    .eq("draft_id", draftId);
  if (!mediaCountRes.error && typeof mediaCountRes.count === "number") {
    photoCount = mediaCountRes.count;
  }
  // filled* slots stay empty here — per-slot tagging is an L7 admin-UI
  // step. A fresh draft therefore lists every gap (design doc §4).
  const checklist = buildChecklist(route.serviceDomain, {
    hasText: Boolean(draft.staff_note && draft.staff_note.trim().length > 0),
    photoCount,
    filledFields: [],
    filledMedia: [],
  });

  const updateRes = await admin
    .from("intake_drafts")
    .update({
      ai_status: "classified",
      ai_summary: suggestion.summary,
      ai_garment_type: suggestion.garmentType,
      ai_repair_category: suggestion.repairCategory,
      ai_repair_area: suggestion.repairArea,
      ai_difficulty: suggestion.difficulty,
      ai_confidence: confidence2dp,
      ai_suggested_price: suggestion.suggestedPrice,
      ai_suggested_service_code: route.serviceDomain,
      ai_suggested_category: route.repairCategory,
      ai_needs_human_review: true,
    })
    .eq("id", draftId);
  if (updateRes.error) {
    console.error(
      "[intake-drafts/classify] update failed",
      updateRes.error
    );
    return NextResponse.json(
      { ok: false, error: `บันทึกผลวิเคราะห์ไม่สำเร็จ: ${updateRes.error.message}` },
      { status: 500 }
    );
  }

  console.log("[intake-drafts/classify] success", {
    draftId,
    rule: suggestion.matchedRule,
    category: suggestion.repairCategory,
    confidence: confidence2dp,
    routerDomain: route.serviceDomain,
    routerConfidence: route.confidence,
    routerBand: route.band,
    checklistMissing: checklist.missing.length,
    requiredComplete: checklist.requiredComplete,
    actor: actor.uid,
  });

  return NextResponse.json({
    ok: true,
    suggestion: {
      garment_type: suggestion.garmentType,
      repair_category: suggestion.repairCategory,
      repair_area: suggestion.repairArea,
      difficulty: suggestion.difficulty,
      confidence: confidence2dp,
      summary: suggestion.summary,
      suggested_price: suggestion.suggestedPrice,
      needs_human_review: true,
    },
    router: {
      service_domain: route.serviceDomain,
      repair_category: route.repairCategory,
      confidence: route.confidence,
      band: route.band,
      signals_used: route.signalsUsed,
      alternatives: route.alternatives,
      matched_keywords: route.matchedKeywords,
    },
    checklist: {
      service_domain: checklist.serviceDomain,
      display_name_th: checklist.displayNameTh,
      have: checklist.have,
      missing: checklist.missing,
      customer_questions: checklist.customerQuestions,
      required_complete: checklist.requiredComplete,
      admin_text: renderAdminChecklist(checklist, {
        draftCode: draft.manual_job_code ?? undefined,
        confidence: route.confidence,
      }),
    },
  });
}
