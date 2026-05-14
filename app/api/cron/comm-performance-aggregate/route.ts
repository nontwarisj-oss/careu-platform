// GET/POST /api/cron/comm-performance-aggregate — nightly per-branch
// communications performance aggregator.
//
// Auth: Bearer CRON_SECRET.
//
// Compute window: previous-day (UTC). Provider webhooks lag by minutes
// at worst, so computing yesterday's day-of avoids race with the
// dispatch worker still writing today's events.
//
// Idempotent: rerunning on the same target day re-computes the same
// values via UPSERT on (branch_id, channel, metric_date).

import { NextResponse } from "next/server";
import { runCommPerformanceAggregateTick } from "@/lib/commPerformanceAggregator";
import { withCronHeartbeat } from "@/lib/cronHeartbeat";

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
  const result = await withCronHeartbeat("comm-performance-aggregate", async () => {
    const r = await runCommPerformanceAggregateTick();
    return {
      result: r,
      payload: {
        rowsProcessed: r.rowsWritten,
        details: { date: r.date, branches: r.branches },
      },
    };
  });
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
