// GET/POST /api/cron/webhook-retry — drains webhook_retry_queue.
//
// Phase 26. Re-applies provider callbacks that verified + parsed
// cleanly but failed during processing. Exponential backoff;
// attempts ≥ max_attempts → dead_letter.
//
// Same auth model as the other cron endpoints: Bearer ${CRON_SECRET}.
// Wrapped with withCronHeartbeat + a worker_locks lock.

import { NextResponse } from "next/server";
import { withCronHeartbeat } from "@/lib/cronHeartbeat";
import { runWebhookRetryTick } from "@/lib/webhookRetryQueue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function readSecret(): string | null {
  const s = process.env.CRON_SECRET ?? "";
  return s.length >= 16 ? s : null;
}

function isAuthorized(req: Request): boolean {
  const secret = readSecret();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length).trim() === secret;
}

async function handle(req: Request) {
  if (!readSecret()) {
    return NextResponse.json(
      { ok: false, reason: "CRON_SECRET ยังไม่ตั้งค่า — endpoint จะตอบ 503" },
      { status: 503 }
    );
  }
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { ok: false, reason: "Unauthorized" },
      { status: 401 }
    );
  }
  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? "");
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.trunc(rawLimit), 100)
      : 25;

  const result = await withCronHeartbeat(
    "webhook-retry",
    async () => {
      const r = await runWebhookRetryTick({ limit });
      return {
        result: r,
        payload: {
          rowsProcessed: r.processed,
          details: {
            succeeded: r.succeeded,
            retried: r.retried,
            deadLettered: r.deadLettered,
          },
        },
      };
    },
    { lockName: "cron:webhook-retry", lockTtlMs: 8 * 60 * 1000 }
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
