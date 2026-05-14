// GET / POST /api/cron/retry-worker — scheduled retry-worker trigger.
//
// Auth model:
//   • CRON_SECRET env var MUST be set. The route returns 503 when it isn't,
//     so a misconfigured deploy fails loud instead of silently allowing
//     anonymous traffic.
//   • Requests must present `Authorization: Bearer <CRON_SECRET>`. This is
//     the header Vercel Cron sends automatically when `CRON_SECRET` is
//     defined on the project. Supabase Cron / external schedulers can be
//     configured to send the same shape.
//   • Vercel Cron uses GET; we accept both GET and POST so external
//     schedulers (curl, Supabase Cron http functions) have flexibility.
//
// Behavior:
//   • Calls runRetryTick({ actorId: 'cron' }) with the configured tick
//     limit. Returns the summary as JSON.
//   • Never blocks the storefront workflow — the function runs in a Node
//     route handler isolated from user requests.
//   • Writes a `worker_runs` heartbeat (via runRetryTick) so operators
//     can see the loop is alive in /admin/recovery.
//
// Vercel Cron setup (vercel.json):
//   {
//     "crons": [
//       { "path": "/api/cron/retry-worker", "schedule": "*/5 * * * *" }
//     ]
//   }
//
// Supabase Cron setup (SQL):
//   select cron.schedule(
//     'careu-retry-worker',
//     '*/5 * * * *',
//     $$ select net.http_post(
//          url := 'https://<deploy>/api/cron/retry-worker',
//          headers := jsonb_build_object(
//            'Authorization', 'Bearer ' || current_setting('app.cron_secret')
//          )
//        ); $$
//   );
//
// Required env vars:
//   • CRON_SECRET                 — shared secret with the scheduler.
//   • SUPABASE_SERVICE_ROLE_KEY   — already required by the worker library.

import { NextResponse } from "next/server";
import { runRetryTick } from "@/lib/retryWorker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

function readSecret(): string | null {
  const s = process.env.CRON_SECRET ?? "";
  return s.length >= 16 ? s : null;
}

function isAuthorized(req: Request): boolean {
  const secret = readSecret();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  return token === secret;
}

function parseLimit(req: Request): number {
  const url = new URL(req.url);
  const raw = url.searchParams.get("limit");
  const parsed = raw ? Number(raw) : DEFAULT_LIMIT;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

async function handle(req: Request) {
  if (!readSecret()) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "CRON_SECRET ยังไม่ตั้งค่า — endpoint จะตอบ 503 จนกว่าจะตั้งใน environment",
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

  const limit = parseLimit(req);
  const result = await runRetryTick({
    limit,
    actorId: "cron",
  });

  return NextResponse.json({
    ok: true,
    actorId: "cron",
    ...result,
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
