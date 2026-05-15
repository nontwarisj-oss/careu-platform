// GET/POST /api/cron/operator-digest — weekly operator digest email.
//
// Phase 23. Generates the 6-section weekly summary (sales, failed
// jobs, broadcast, CRM engagement, payroll, branch comparison) and
// emails it to every recipient across alert_preferences rows with
// digest_enabled. Schedule this once a week (e.g. Monday 08:00 BKK).
//
// Same auth model as the other cron endpoints: Bearer ${CRON_SECRET}.
// A `?periodDays=N` query param overrides the 7-day window (1–31).
//
// The digest never throws — each section degrades to "(unavailable)"
// independently; an unconfigured email provider logs to console.

import { NextResponse } from "next/server";
import { withCronHeartbeat } from "@/lib/cronHeartbeat";
import { sendOperatorDigest } from "@/lib/operatorDigest";

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
  const rawDays = Number(url.searchParams.get("periodDays") ?? "");
  const periodDays =
    Number.isFinite(rawDays) && rawDays > 0
      ? Math.min(Math.trunc(rawDays), 31)
      : 7;

  const result = await withCronHeartbeat(
    "operator-digest",
    async () => {
      const r = await sendOperatorDigest({ periodDays });
      return {
        result: r,
        payload: {
          rowsProcessed: r.sent,
          details: {
            recipients: r.recipients,
            sent: r.sent,
            failed: r.failed,
            period: `${r.periodStart}..${r.periodEnd}`,
          },
        },
      };
    },
    { lockName: "cron:operator-digest", lockTtlMs: 5 * 60 * 1000 }
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
