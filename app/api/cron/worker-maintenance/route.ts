// GET/POST /api/cron/worker-maintenance — Phase 22 housekeeping tick.
//
// Two jobs, run every ~15 minutes:
//   1. Worker lock janitor — delete expired rows from worker_locks so
//      a crashed cron's lock can't linger.
//   2. Alert sweep — evaluate communication_alert_rules against
//      current worker health, persist breaches into alert_events,
//      auto-resolve cleared ones, route NEW alerts to operator
//      channels (Slack / email / LINE per env).
//
// Same auth model as the other cron endpoints: Bearer ${CRON_SECRET}.
// Wrapped with withCronHeartbeat + a worker_lock so two overlapping
// maintenance ticks short-circuit cleanly.

import { NextResponse } from "next/server";
import { withCronHeartbeat } from "@/lib/cronHeartbeat";
import { runLockJanitorTick } from "@/lib/workerLockJanitor";
import { evaluateAndRecordAlerts } from "@/lib/alertEvents";

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

  const result = await withCronHeartbeat(
    "worker-maintenance",
    async () => {
      const janitor = await runLockJanitorTick();
      const alerts = await evaluateAndRecordAlerts("worker-maintenance");
      return {
        result: { janitor, alerts },
        payload: {
          rowsProcessed: janitor.released + alerts.fired,
          details: {
            locksReleased: janitor.released,
            longHeldLocks: janitor.longHeld.length,
            alertsFired: alerts.fired,
            alertsRepeated: alerts.repeated,
            alertsAutoResolved: alerts.autoResolved,
          },
        },
      };
    },
    { lockName: "cron:worker-maintenance", lockTtlMs: 10 * 60 * 1000 }
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
