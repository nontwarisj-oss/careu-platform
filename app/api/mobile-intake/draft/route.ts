// POST /api/mobile-intake/draft — create one intake draft + its media.
//
// No session gate: the mobile staff flow has no login (see upload-url).
// Writes go through the service-role admin client, so RLS on
// intake_drafts / intake_draft_media can stay fully locked.
//
// Identity model (Phase A — manual front-counter code):
//   • `manualJobCode` is REQUIRED. It is the queue number the shop runs
//     internally and the same number staff writes on the bag tag. It is
//     carried into orders.job_id when an owner/admin converts the draft.
//   • `draft_code` (DYYMMDD-NNN) is still generated as a system-internal
//     short id (fallback only) — its NOT NULL UNIQUE constraint requires
//     a value, and it stays useful for log / audit references.
//
// Duplicate validation (branch-scoped, mirrors /api/orders/check-job-id):
//   • intake_drafts where (branch_id, manual_job_code) collides AND status
//     is not CANCELLED → 409.
//   • orders where (branch_id, job_id) collides within the same 45-day
//     rolling window the order intake form uses → 409.
//   • A genuine lookup failure NEVER reports duplicate — same rule as
//     check-job-id, so staff are never wrongly blocked.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { buildDraftCode, draftDateStamp, parseDraftSeq } from "@/lib/draftCode";
import { normalizeJobId } from "@/lib/jobId";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Same 45-day rolling window /api/orders/check-job-id uses. Kept in sync
 *  so staff can't pick a code on the mobile form that the intake form
 *  would still flag as duplicate. */
const JOB_ID_DUPLICATE_WINDOW_DAYS = 45;

type MediaInput = { mediaType?: string; fileUrl?: string };
type Body = {
  branchId?: string;
  /** REQUIRED — the front-counter queue number the staff writes on the bag. */
  manualJobCode?: string;
  customerName?: string;
  customerPhone?: string;
  staffNote?: string;
  urgentRequested?: boolean;
  media?: MediaInput[];
};

function clean(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v === "" ? null : v;
}

/** Best-effort client IP for abuse triage. Vercel forwards via x-forwarded-for;
 *  fall back to x-real-ip; never throws. */
function readClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || null;
  return req.headers.get("x-real-ip");
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "service role ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  const branchId = clean(body.branchId);

  // ---- Manual job code: required + normalize ---------------------------
  const manualJobCode = normalizeJobId(body.manualJobCode);
  if (!manualJobCode) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "กรุณากรอกรหัสรับงาน / เลขคิวที่จะเขียนติดถุง (ห้ามว่าง)",
      },
      { status: 400 }
    );
  }

  // ---- Duplicate validation (branch-scoped, app-layer) -----------------
  // Both probes mirror the rule in /api/orders/check-job-id: a genuine
  // lookup failure must NOT be reported as a duplicate.
  if (branchId) {
    const draftDup = await admin
      .from("intake_drafts")
      .select("id", { head: true, count: "exact" })
      .eq("branch_id", branchId)
      .eq("manual_job_code", manualJobCode)
      .neq("status", "CANCELLED");
    if (draftDup.error) {
      console.error("[mobile-intake/draft] draft dup probe failed", {
        message: draftDup.error.message,
        code: draftDup.error.code,
        branchId,
        manualJobCode,
      });
      return NextResponse.json(
        { ok: false, error: "ตรวจสอบรหัสซ้ำไม่สำเร็จ — ลองอีกครั้ง" },
        { status: 500 }
      );
    }
    if ((draftDup.count ?? 0) > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "รหัสรับงานนี้ถูกใช้แล้ว กรุณาตรวจสอบเลขคิวอีกครั้ง",
          state: "duplicate",
        },
        { status: 409 }
      );
    }

    const windowStart = new Date(
      Date.now() - JOB_ID_DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const orderDup = await admin
      .from("orders")
      .select("id", { head: true, count: "exact" })
      .eq("branch_id", branchId)
      .eq("job_id", manualJobCode)
      .gte("created_at", windowStart);
    if (orderDup.error) {
      console.error("[mobile-intake/draft] order dup probe failed", {
        message: orderDup.error.message,
        code: orderDup.error.code,
        branchId,
        manualJobCode,
      });
      return NextResponse.json(
        { ok: false, error: "ตรวจสอบรหัสซ้ำไม่สำเร็จ — ลองอีกครั้ง" },
        { status: 500 }
      );
    }
    if ((orderDup.count ?? 0) > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "รหัสรับงานนี้ถูกใช้แล้ว กรุณาตรวจสอบเลขคิวอีกครั้ง",
          state: "duplicate",
        },
        { status: 409 }
      );
    }
  }

  const draftRow = {
    branch_id: branchId,
    manual_job_code: manualJobCode,
    customer_name: clean(body.customerName),
    customer_phone: clean(body.customerPhone),
    staff_note: clean(body.staffNote),
    urgent_requested: body.urgentRequested === true,
    status: "NEW",
    client_ip: readClientIp(req),
    client_user_agent: req.headers.get("user-agent"),
  };

  // ---- Daily Draft ID sequence (system-internal fallback id) ------------
  const stamp = draftDateStamp();
  const latest = await admin
    .from("intake_drafts")
    .select("draft_code")
    .like("draft_code", `D${stamp}-%`)
    .order("draft_code", { ascending: false })
    .limit(1);
  if (latest.error) {
    console.error("[mobile-intake/draft] seq lookup failed", latest.error);
    return NextResponse.json(
      { ok: false, error: `อ่านลำดับ Draft ID ไม่สำเร็จ: ${latest.error.message}` },
      { status: 500 }
    );
  }
  let seq = 1;
  const top = ((latest.data ?? []) as Array<{ draft_code: string }>)[0];
  if (top) {
    const parsed = parseDraftSeq(top.draft_code);
    if (parsed) seq = parsed + 1;
  }

  // Insert; on a unique-violation (concurrent submit OR partial-unique
  // index on manual_job_code) report the right thing.
  let draftId: string | null = null;
  let draftCode = "";
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = buildDraftCode(stamp, seq);
    const ins = await admin
      .from("intake_drafts")
      .insert({ ...draftRow, draft_code: code })
      .select("id")
      .single();
    if (!ins.error && ins.data) {
      draftId = (ins.data as { id: string }).id;
      draftCode = code;
      break;
    }
    if (ins.error && ins.error.code === "23505") {
      // Discriminate: did draft_code collide (bump seq + retry) or did
      // the partial-unique on (branch_id, manual_job_code) fire (someone
      // raced us between the probe above and now → duplicate)?
      const msg = ins.error.message ?? "";
      if (/manual_job_code/i.test(msg)) {
        return NextResponse.json(
          {
            ok: false,
            error: "รหัสรับงานนี้ถูกใช้แล้ว กรุณาตรวจสอบเลขคิวอีกครั้ง",
            state: "duplicate",
          },
          { status: 409 }
        );
      }
      seq += 1;
      continue;
    }
    console.error("[mobile-intake/draft] insert failed", ins.error);
    return NextResponse.json(
      { ok: false, error: ins.error?.message ?? "สร้าง draft ไม่สำเร็จ" },
      { status: 500 }
    );
  }
  if (!draftId) {
    return NextResponse.json(
      { ok: false, error: "สร้าง Draft ID ไม่สำเร็จ — ลองอีกครั้ง" },
      { status: 500 }
    );
  }

  // ---- Media rows -------------------------------------------------------
  const mediaItems = Array.isArray(body.media) ? body.media : [];
  const mediaRows = mediaItems
    .filter((m) => typeof m.fileUrl === "string" && m.fileUrl.trim() !== "")
    .map((m) => ({
      draft_id: draftId,
      media_type:
        m.mediaType === "video"
          ? "video"
          : m.mediaType === "audio"
            ? "audio"
            : "image",
      file_url: (m.fileUrl as string).trim(),
    }));

  if (mediaRows.length > 0) {
    const mins = await admin.from("intake_draft_media").insert(mediaRows);
    if (mins.error) {
      // The draft itself saved — report the media failure without losing it.
      console.error("[mobile-intake/draft] media insert failed", mins.error);
      return NextResponse.json({
        ok: true,
        draftCode,
        draftId,
        manualJobCode,
        mediaSaved: 0,
        mediaWarning: mins.error.message,
      });
    }
  }

  console.log("[mobile-intake/draft] created", {
    draftCode,
    manualJobCode,
    branchId,
    media: mediaRows.length,
  });
  return NextResponse.json({
    ok: true,
    draftCode,
    draftId,
    manualJobCode,
    mediaSaved: mediaRows.length,
  });
}
