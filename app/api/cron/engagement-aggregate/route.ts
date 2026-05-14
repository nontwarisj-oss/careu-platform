// GET/POST /api/cron/engagement-aggregate — nightly engagement metrics
// + lifecycle classification sweep.
//
// Auth: Bearer CRON_SECRET. Same pattern as the other cron endpoints.
//
// Per tick: processes the most-recently-active customers first
// (lim=500), computes customer_engagement_daily + classifies into
// customer_lifecycle_status with an explainable reason.
//
// Recommended cadence: daily at 02:30 Bangkok. Multiple ticks per day
// are fine — the UPSERTs are idempotent within the same metric_date.

import { NextResponse } from "next/server";
import { runEngagementAggregateTick } from "@/lib/engagementMetricsService";
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
  const url = new URL(req.url);
  const limit = Math.max(
    1,
    Math.min(Number(url.searchParams.get("limit") ?? 500), 5000)
  );
  const result = await withCronHeartbeat("engagement-aggregate", async () => {
    const r = await runEngagementAggregateTick({ limit });
    return {
      result: r,
      payload: {
        rowsProcessed: r.processed,
        details: {
          lifecycleChanges: r.lifecycleChanges,
          rowsWritten: r.rowsWritten,
          failures: r.failures,
          asOfDate: r.asOfDate,
        },
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
