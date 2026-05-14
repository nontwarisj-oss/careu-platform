// GET/POST /api/cron/heic-transcode — scheduled HEIC normalization
// processor.
//
// Drains media_transcode_queue. Per-row workflow:
//   1. Pick rows in status='pending', flag as 'processing' (optimistic
//      concurrency on the queued status).
//   2. Download the HEIC bytes from the storage path.
//   3. Transcode → JPEG with EXIF orientation applied + metadata
//      stripped. Re-upload to a sibling path (suffix .jpg).
//   4. Update output_path + status='done', processed_at=now.
//   5. On failure: increment attempts, back off, dead-letter after 3.
//
// THIS PHASE: the orchestration is wired (queue read + status
// transitions + dead-letter). The actual TRANSCODER call is a
// placeholder because no HEIC library is in deps yet. Operator wires
// `sharp` (which supports HEIC via libheif) or a Supabase Edge
// Function with libvips by replacing `transcodeHeicToJpeg`. The
// signature is stable.
//
// Auth: Bearer ${CRON_SECRET}. Same pattern as other cron routes.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SWEEP_LIMIT = 20;
const MAX_ATTEMPTS = 3;
/** When the real transcoder isn't wired (process.env.HEIC_TRANSCODER
 *  is "stub" / unset), every row stays in 'pending' and the cron is a
 *  no-op. Set HEIC_TRANSCODER=disabled to mark all pending rows as
 *  dead_letter at the next tick — useful when shutting down the
 *  feature on a deploy. */
const TRANSCODER_MODE = (process.env.HEIC_TRANSCODER ?? "stub").toLowerCase();

type QueueRow = {
  id: string;
  source_path: string;
  source_mime: string;
  operation: string;
  status: string;
  attempts: number;
  customer_id: string | null;
  order_id: string | null;
  branch_id: string | null;
};

function unauthorized(reason: string) {
  return NextResponse.json({ ok: false, reason }, { status: 401 });
}

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, reason: "CRON_SECRET ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  const header = req.headers.get("authorization") ?? "";
  if (header !== `Bearer ${secret}`) {
    return unauthorized("invalid bearer");
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  const res = await admin
    .from("media_transcode_queue")
    .select(
      "id, source_path, source_mime, operation, status, attempts, customer_id, order_id, branch_id"
    )
    .in("status", ["pending"])
    .order("created_at", { ascending: true })
    .limit(SWEEP_LIMIT);
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  const rows = (res.data ?? []) as QueueRow[];
  const outcomes: Array<{
    id: string;
    status: string;
    reason: string | null;
  }> = [];

  for (const row of rows) {
    const nextAttempts = row.attempts + 1;
    // Flag as processing — optimistic concurrency means we won't pick
    // a row another worker is already on.
    const flag = await admin
      .from("media_transcode_queue")
      .update({ status: "processing", attempts: nextAttempts })
      .eq("id", row.id)
      .eq("status", "pending");
    if (flag.error) {
      outcomes.push({
        id: row.id,
        status: "race",
        reason: flag.error.message,
      });
      continue;
    }

    if (TRANSCODER_MODE === "disabled") {
      // Operational kill-switch — mark everything as dead_letter so the
      // queue doesn't grow forever while the feature is shut off.
      await admin
        .from("media_transcode_queue")
        .update({
          status: "dead_letter",
          error_reason: "HEIC_TRANSCODER=disabled",
          processed_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      outcomes.push({ id: row.id, status: "dead_letter", reason: "disabled" });
      continue;
    }
    if (TRANSCODER_MODE === "stub") {
      // No transcoder wired yet — leave row as 'processing' but reset
      // back to 'pending' so the next operator with a real transcoder
      // can pick it up. The HEIC bytes themselves remain in storage
      // (iOS Safari can still render them).
      await admin
        .from("media_transcode_queue")
        .update({
          status: "pending",
          error_reason: "no transcoder wired (HEIC_TRANSCODER=stub)",
        })
        .eq("id", row.id);
      outcomes.push({
        id: row.id,
        status: "deferred",
        reason: "transcoder stub",
      });
      continue;
    }

    // Real transcoder path — placeholder. When sharp / libvips is in
    // deps, replace this block with the actual decode + re-encode +
    // re-upload to a sibling path.
    const transcoded = await transcodeHeicToJpeg({
      sourcePath: row.source_path,
    });
    if (transcoded.ok) {
      await admin
        .from("media_transcode_queue")
        .update({
          status: "done",
          output_path: transcoded.outputPath,
          processed_at: new Date().toISOString(),
          error_reason: null,
        })
        .eq("id", row.id);
      outcomes.push({ id: row.id, status: "done", reason: null });
    } else {
      const reachedDead = nextAttempts >= MAX_ATTEMPTS;
      await admin
        .from("media_transcode_queue")
        .update({
          status: reachedDead ? "dead_letter" : "pending",
          error_reason: transcoded.reason,
          processed_at: reachedDead ? new Date().toISOString() : null,
        })
        .eq("id", row.id);
      outcomes.push({
        id: row.id,
        status: reachedDead ? "dead_letter" : "retry",
        reason: transcoded.reason,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    processed: rows.length,
    outcomes,
    transcoderMode: TRANSCODER_MODE,
    sweptAt: new Date().toISOString(),
  });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}

// ---------- Placeholder transcoder --------------------------------------
//
// Replace with sharp+libheif or a Supabase Edge Function call. The
// signature is stable — anything that returns a sibling JPEG path is
// fine.

async function transcodeHeicToJpeg(_args: {
  sourcePath: string;
}): Promise<
  | { ok: true; outputPath: string }
  | { ok: false; reason: string }
> {
  return {
    ok: false,
    reason:
      "transcoder not wired — set HEIC_TRANSCODER=stub to defer, or wire a real decoder",
  };
}
