// GET / POST /api/cron/dispatch-worker — scheduled notification dispatch.
// Identical auth shape to /api/cron/retry-worker (Bearer CRON_SECRET).

import { NextResponse } from "next/server";
import { runDispatchTick } from "@/lib/notificationDispatchWorker";
import { withCronHeartbeat } from "@/lib/cronHeartbeat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

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
      {
        ok: false,
        reason: "CRON_SECRET ยังไม่ตั้งค่า — endpoint จะตอบ 503",
      },
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
  const raw = Number(url.searchParams.get("limit") ?? "");
  const limit =
    Number.isFinite(raw) && raw > 0
      ? Math.min(Math.floor(raw), MAX_LIMIT)
      : DEFAULT_LIMIT;
  const result = await withCronHeartbeat(
    "dispatch-worker",
    async () => {
      const r = await runDispatchTick({ limit, actorId: "cron" });
      return {
        result: r,
        payload: {
          rowsProcessed: r.processed,
          details: {
            succeeded: r.succeeded,
            failed: r.failed,
            dead: r.dead,
            skipped: r.skipped,
          },
        },
      };
    },
    { lockName: "cron:dispatch-worker", lockTtlMs: 4 * 60 * 1000 }
  );
  if ("skipped" in result && result.skipped === true) {
    return NextResponse.json({ ok: true, actorId: "cron", skipped: true, reason: result.reason });
  }
  return NextResponse.json({ ok: true, actorId: "cron", ...result });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
