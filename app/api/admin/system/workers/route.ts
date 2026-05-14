// GET /api/admin/system/workers — worker telemetry dashboard payload.
//
// Owner / hq_admin only — system-level surface. Returns:
//   • per-cron status (last run, success rate, silence, expected interval)
//   • queue health (totals, oldest queued, stuck sending)
//   • alert hits (rules that breached their threshold)
//   • overall: healthy | warning | critical
//
// Read-only; no side effects. The dashboard polls this on a slow
// schedule (30 s default) — every read does one cron_heartbeat scan
// + small counted queries against customer_notifications.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { computeWorkerHealth } from "@/lib/workerHealth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const snapshot = await computeWorkerHealth();
  return NextResponse.json({ ok: true, ...snapshot });
}
