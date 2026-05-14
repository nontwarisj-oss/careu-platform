// GET/POST /api/cron/broadcast-send — scheduled broadcast fan-out tick.
//
// Same auth model as the other cron endpoints: Bearer ${CRON_SECRET}.
//
// Per-tick behaviour:
//   1. Fetch up to N broadcast_send_jobs in status queued/processing
//      whose scheduled_for has elapsed.
//   2. For each job: run one fan-out tick (chunk_size = 50 targets).
//   3. Return per-job outcomes for forensics.
//
// Idempotent across runs: optimistic-concurrency target updates +
// the fan-out's UPSERT semantics make it safe to re-run on a crashed
// tick. Pause/cancel are respected at each tick boundary — a paused
// job's status check fails the schedule gate and it skips.

import { NextResponse } from "next/server";
import { runBroadcastSendTick } from "@/lib/broadcastSendWorker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    return NextResponse.json(
      { ok: false, reason: "invalid bearer" },
      { status: 401 }
    );
  }
  const url = new URL(req.url);
  const limit = Math.max(
    1,
    Math.min(Number(url.searchParams.get("limit") ?? 5), 25)
  );
  const result = await runBroadcastSendTick({ jobLimit: limit, actorId: null });
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
