// GET  /api/admin/system/alerts — list persisted alert_events.
// POST /api/admin/system/alerts — acknowledge / resolve an event, or
//        run an on-demand worker-maintenance sweep.
//
// Phase 22. Distinct from /api/admin/system/alert-rules (which manages
// the THRESHOLDS). This route works the EVENTS those thresholds fire.
//
// Owner / hq_admin see every event. branch_manager sees their own
// branch's events (RLS on alert_events also enforces this).

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import {
  acknowledgeAlert,
  evaluateAndRecordAlerts,
  listAlertDeliveries,
  listAlertEvents,
  replayAlertRouting,
  resolveAlert,
} from "@/lib/alertEvents";
import { runLockJanitorTick } from "@/lib/workerLockJanitor";
import { sendOperatorDigest } from "@/lib/operatorDigest";

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

  // ?view=deliveries — Phase 23 alert-history feed (sent / delivered /
  // failed / skipped, including weekly-digest sends).
  if (url.searchParams.get("view") === "deliveries") {
    const deliveries = await listAlertDeliveries({
      branchId: branchCode,
      limit: 120,
    });
    return NextResponse.json({ ok: true, deliveries });
  }

  const statusParam = url.searchParams.get("status");
  const statuses =
    statusParam === "all"
      ? undefined
      : statusParam
        ? (statusParam.split(",") as Array<
            "active" | "acknowledged" | "resolved"
          >)
        : (["active", "acknowledged"] as Array<
            "active" | "acknowledged" | "resolved"
          >);

  const events = await listAlertEvents({
    statuses,
    branchId: branchCode,
    limit: 200,
  });
  return NextResponse.json({ ok: true, events });
}

type Body = {
  action?:
    | "acknowledge"
    | "resolve"
    | "run-maintenance"
    | "send-digest"
    | "replay-escalation";
  id?: string;
};

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "alerts-write",
    limit: 60,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "ลองมากเกินไป" },
      { status: 429 }
    );
  }

  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
  ]);
  if (guarded instanceof NextResponse) return guarded;
  const actorId = guarded.profile.id;
  const role = guarded.profile.role ?? "owner";

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (body.action === "run-maintenance") {
    // Owner / HQ only — a manual sweep is the "safe admin action"
    // for the lock janitor + alert evaluator.
    if (role !== "owner" && role !== "hq_admin") {
      return NextResponse.json(
        { ok: false, reason: "owner / hq_admin only" },
        { status: 403 }
      );
    }
    const janitor = await runLockJanitorTick();
    const alerts = await evaluateAndRecordAlerts("manual");
    return NextResponse.json({ ok: true, janitor, alerts });
  }

  if (body.action === "send-digest") {
    // Owner / HQ only — manual trigger of the weekly operator digest.
    if (role !== "owner" && role !== "hq_admin") {
      return NextResponse.json(
        { ok: false, reason: "owner / hq_admin only" },
        { status: 403 }
      );
    }
    const digest = await sendOperatorDigest();
    return NextResponse.json({ ok: true, digest });
  }

  if (!body.id) {
    return NextResponse.json(
      { ok: false, reason: "id required" },
      { status: 400 }
    );
  }

  if (body.action === "replay-escalation") {
    // Owner / HQ only — re-route an alert NOW (replay console).
    if (role !== "owner" && role !== "hq_admin") {
      return NextResponse.json(
        { ok: false, reason: "owner / hq_admin only" },
        { status: 403 }
      );
    }
    const r = await replayAlertRouting(body.id);
    return NextResponse.json(
      { ok: r.ok, reason: r.reason, outcomes: r.outcomes },
      { status: r.ok ? 200 : 409 }
    );
  }

  if (body.action === "acknowledge") {
    const r = await acknowledgeAlert(body.id, actorId);
    return NextResponse.json(
      { ok: r.ok, reason: r.reason },
      { status: r.ok ? 200 : 409 }
    );
  }
  if (body.action === "resolve") {
    const r = await resolveAlert(body.id, actorId);
    return NextResponse.json(
      { ok: r.ok, reason: r.reason },
      { status: r.ok ? 200 : 409 }
    );
  }

  return NextResponse.json(
    { ok: false, reason: "unknown action" },
    { status: 400 }
  );
}
