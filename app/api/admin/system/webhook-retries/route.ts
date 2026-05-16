// GET  /api/admin/system/webhook-retries — list the webhook retry /
//        dead-letter queue.
// POST /api/admin/system/webhook-retries — replay a row.
//
// Phase 26. The dead-letter explorer + the webhook half of the
// replay console. owner / hq_admin see all; branch_manager is scoped
// to their own branch.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import {
  listWebhookRetries,
  replayWebhookRetry,
} from "@/lib/webhookRetryQueue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
  ]);
  if (guarded instanceof NextResponse) return guarded;
  const role = guarded.profile.role ?? "owner";
  const branchCode =
    role === "owner" || role === "hq_admin"
      ? null
      : (guarded.profile.branchCode ?? null);

  const url = new URL(req.url);
  const rows = await listWebhookRetries({
    status: url.searchParams.get("status") ?? undefined,
    provider: url.searchParams.get("provider") ?? undefined,
    branchId: branchCode,
    limit: 150,
  });
  return NextResponse.json({ ok: true, rows });
}

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "webhook-retry-replay",
    limit: 30,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "ลองมากเกินไป" },
      { status: 429 }
    );
  }

  // Replay is a write action — owner / hq_admin only.
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const actorId = guarded.profile.id;

  let body: { action?: string; id?: string };
  try {
    body = (await req.json()) as { action?: string; id?: string };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  if (body.action !== "replay" || !body.id) {
    return NextResponse.json(
      { ok: false, reason: "action='replay' + id required" },
      { status: 400 }
    );
  }

  const result = await replayWebhookRetry(body.id, actorId);

  // Audit the replay.
  const admin = getSupabaseAdmin();
  if (admin) {
    try {
      const now = new Date().toISOString();
      await admin.from("cron_heartbeat_logs").insert({
        cron_name: "settings-edit",
        started_at: now,
        finished_at: now,
        duration_ms: 0,
        success: result.ok,
        rows_processed: result.ok ? 1 : 0,
        details: {
          kind: "webhook_retry_replay",
          retryId: body.id,
          actorId,
          ok: result.ok,
          reason: result.reason ?? null,
          ip: ip === "unknown" ? null : ip,
        },
      });
    } catch {
      // best-effort
    }
  }

  return NextResponse.json(
    { ok: result.ok, reason: result.reason, applied: result.applied },
    { status: result.ok ? 200 : 409 }
  );
}
