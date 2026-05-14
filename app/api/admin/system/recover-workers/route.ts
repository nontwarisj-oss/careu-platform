// POST /api/admin/system/recover-workers — operator self-heal.
//
// Owner / hq_admin only. Rate-limited 5/10min/IP — recovery is rare
// and intentional, not something to spam.
//
// Actions run sequentially:
//   1. recoverStuckSending — flip 'sending' rows older than the
//      stall window back to 'queued' so the next tick picks them up.
//   2. recoverStuckBroadcastJobs — observe (no automatic reset) for
//      broadcast jobs the cron has abandoned.
//   3. detectInconsistentStates — observe queue rows in 'sending'
//      for > 1h (probable webhook issue).
//
// Audit: every recovery action lands in audit log (free-form via the
// auditService order domain, with action='cost_updated' as a generic
// "operator administrative action" — sorry for the squat, the action
// enum predates this surface). Better: write to a dedicated system
// log later. For now we just stamp a customer_activity row keyed to
// the operator.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import {
  recoverStuckSending,
  recoverStuckBroadcastJobs,
  detectInconsistentStates,
  type RecoverActionResult,
} from "@/lib/workerHealth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "system-recover-workers",
    limit: 5,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "ลองมากเกินไป" },
      { status: 429 }
    );
  }

  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const actorId = guarded.profile.id;

  const results: RecoverActionResult[] = [];
  try {
    results.push(await recoverStuckSending());
  } catch (err) {
    results.push({
      action: "stuck_sending",
      rowsAffected: 0,
      details: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
  try {
    results.push(await recoverStuckBroadcastJobs());
  } catch (err) {
    results.push({
      action: "stuck_broadcast_jobs",
      rowsAffected: 0,
      details: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
  try {
    results.push(await detectInconsistentStates());
  } catch (err) {
    results.push({
      action: "inconsistent_states",
      rowsAffected: 0,
      details: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }

  // Audit row — append to cron_heartbeat_logs as a synthetic "manual"
  // tick. Keeps the audit trail visible in the same dashboard the
  // operator was looking at when they clicked.
  const admin = getSupabaseAdmin();
  if (admin) {
    try {
      await admin.from("cron_heartbeat_logs").insert({
        cron_name: "manual-recover",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 0,
        success: true,
        rows_processed: results.reduce(
          (acc, r) => acc + r.rowsAffected,
          0
        ),
        details: {
          actorId,
          ip: ip === "unknown" ? null : ip,
          actions: results,
        },
      });
    } catch {
      // Best-effort.
    }
  }

  return NextResponse.json({ ok: true, actions: results });
}
