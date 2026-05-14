// POST /api/admin/notifications/send — operator-triggered lifecycle
// send. Different from /api/internal/lifecycle-event in two ways:
//   1. Always sets `force: true` so the 6-hour dedup window doesn't
//      block the operator. The per-customer rate limiter still
//      applies — that's the real spam guard.
//   2. Writes a notification_resend_log row under action='resend' so
//      "operator manually sent this" appears in the audit trail.
//
// Allowed events:
//   • ready_for_pickup   — "the work is done, come get it"
//   • overdue_pickup     — "the work has been waiting too long"
//   • payment_received   — "we got your money, thanks"
//   • order_completed    — "loop closed, see you next time"
//
// order_created / repair_started are NOT operator-triggerable — those
// are status transitions that should fire from real events.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import {
  notifyLifecycleEvent,
  type LifecycleEvent,
} from "@/lib/lifecycleNotifier";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OPERATOR_ALLOWED_EVENTS: LifecycleEvent[] = [
  "ready_for_pickup",
  "overdue_pickup",
  "payment_received",
  "order_completed",
];

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "admin-manual-send",
    limit: 30,
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
    "front_staff",
  ]);
  if (guarded instanceof NextResponse) return guarded;
  const actorId = guarded.profile.id;

  let body: { event?: string; orderId?: string; reason?: string };
  try {
    body = (await req.json()) as {
      event?: string;
      orderId?: string;
      reason?: string;
    };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const event = body.event;
  const orderId = body.orderId;
  if (!event || !orderId) {
    return NextResponse.json(
      { ok: false, reason: "event + orderId required" },
      { status: 400 }
    );
  }
  if (!OPERATOR_ALLOWED_EVENTS.includes(event as LifecycleEvent)) {
    return NextResponse.json(
      {
        ok: false,
        reason: `event "${event}" is not operator-triggerable`,
      },
      { status: 400 }
    );
  }

  // Pre-check branch ownership.
  const admin = getSupabaseAdmin();
  if (admin) {
    const orderRes = await admin
      .from("orders")
      .select("branch_id, customer_id")
      .eq("id", orderId)
      .maybeSingle();
    const data = orderRes.data as
      | { branch_id: string | null; customer_id: string | null }
      | null;
    if (data?.branch_id) {
      const branchGuard = await requireBranchAccess(data.branch_id);
      if (branchGuard instanceof NextResponse) return branchGuard;
    }
  }

  const result = await notifyLifecycleEvent({
    event: event as LifecycleEvent,
    orderId,
    actorId,
    force: true,
  });

  // Audit. We record the manual send via notification_resend_log under
  // action='resend' so the dispatch UI shows "operator manually
  // triggered this".
  if (admin && result.outcomes.some((o) => o.enqueued)) {
    const newId = result.outcomes.find((o) => o.enqueued)?.notificationId ?? null;
    try {
      await admin.from("notification_resend_log").insert({
        notification_id: null,
        new_notification_id: newId,
        action: "resend",
        actor_id: actorId,
        reason:
          (body.reason ?? null) ||
          `manual send: ${event} for order ${orderId}`,
        request_ip: ip === "unknown" ? null : ip,
        customer_id: result.customerId,
        branch_id: result.outcomes[0]?.enqueued
          ? null
          : null /* set below */,
      });
    } catch {
      // best-effort
    }
  }

  return NextResponse.json({ ...result, ok: result.ok });
}
