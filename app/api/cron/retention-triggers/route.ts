// GET/POST /api/cron/retention-triggers — periodic retention trigger
// sweep.
//
// Auth: Bearer CRON_SECRET.
//
// Per tick:
//   • If outside Bangkok quiet hours → record a heartbeat with
//     blockedReason + dispatch nothing.
//   • Otherwise: process each trigger kind (≤ 100 customers per kind),
//     apply dedup + policy + render + enqueue.
//
// Recommended cadence: hourly during business hours (09–19 Bangkok).
// Quiet-hours guard makes off-hours ticks safe to leave scheduled.

import { NextResponse } from "next/server";
import { runRetentionTriggerTick } from "@/lib/retentionTriggerService";
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
  const perKindLimit = Math.max(
    1,
    Math.min(Number(url.searchParams.get("perKindLimit") ?? 100), 500)
  );

  const result = await withCronHeartbeat(
    "retention-triggers",
    async () => {
      const r = await runRetentionTriggerTick({ perKindLimit });
      const totals = Object.values(r.perKind).reduce(
        (acc, k) => {
          acc.candidates += k.candidates;
          acc.fired += k.fired;
          acc.deduped += k.deduped;
          acc.skipped += k.skipped;
          acc.failed += k.failed;
          return acc;
        },
        { candidates: 0, fired: 0, deduped: 0, skipped: 0, failed: 0 }
      );
      return {
        result: r,
        payload: {
          rowsProcessed: totals.fired,
          details: {
            candidates: totals.candidates,
            fired: totals.fired,
            deduped: totals.deduped,
            skipped: totals.skipped,
            failed: totals.failed,
            blockedReason: r.blockedReason,
          },
        },
      };
    },
    { lockName: "cron:retention-triggers", lockTtlMs: 9 * 60 * 1000 }
  );
  if ("skipped" in result && result.skipped === true) {
    return NextResponse.json({ ok: true, skipped: true, reason: result.reason });
  }
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
