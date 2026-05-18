// POST /api/mobile-intake/draft — create one intake draft + its media.
//
// No session gate: the mobile staff flow has no login (see upload-url).
// Writes go through the service-role admin client, so RLS on
// intake_drafts / intake_draft_media can stay fully locked.
//
// Generates a short Draft ID (DYYMMDD-NNN) with a daily sequence. The
// draft_code column is UNIQUE, so a concurrent submit that collides on a
// sequence number is retried with the next number.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { buildDraftCode, draftDateStamp, parseDraftSeq } from "@/lib/draftCode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MediaInput = { mediaType?: string; fileUrl?: string };
type Body = {
  branchId?: string;
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

  const draftRow = {
    branch_id: clean(body.branchId),
    customer_name: clean(body.customerName),
    customer_phone: clean(body.customerPhone),
    staff_note: clean(body.staffNote),
    urgent_requested: body.urgentRequested === true,
    status: "NEW",
  };

  // ---- Daily Draft ID sequence ------------------------------------------
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

  // Insert; on a unique-violation (concurrent submit) bump the sequence.
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
        mediaSaved: 0,
        mediaWarning: mins.error.message,
      });
    }
  }

  console.log("[mobile-intake/draft] created", {
    draftCode,
    media: mediaRows.length,
  });
  return NextResponse.json({
    ok: true,
    draftCode,
    draftId,
    mediaSaved: mediaRows.length,
  });
}
