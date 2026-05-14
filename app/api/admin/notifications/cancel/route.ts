// POST /api/admin/notifications/cancel — cancel a queued notification
// before it ships.
//
// Rules:
//   • Only rows in 'queued' / 'sending' can be cancelled. Already-sent
//     or delivered rows are immutable from the operator's side — once
//     the SMS left the provider you can't recall it.
//   • Cancellation is a forward-only transition; we set status=
//     'cancelled', cancelled_at=now, cancelled_by=operator.
//   • The worker's optimistic concurrency on status='queued' means a
//     race between cancel + worker pickup is safe: whoever wins, the
//     other gets a 0-row update.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "admin-cancel",
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

  let body: { notificationId?: string; reason?: string };
  try {
    body = (await req.json()) as { notificationId?: string; reason?: string };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const id = body.notificationId;
  if (!id) {
    return NextResponse.json(
      { ok: false, reason: "notificationId required" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  const lookup = await admin
    .from("customer_notifications")
    .select("id, customer_id, branch_id, channel, kind, status")
    .eq("id", id)
    .maybeSingle();
  if (lookup.error || !lookup.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบ notification" },
      { status: 404 }
    );
  }
  const row = lookup.data as {
    id: string;
    customer_id: string | null;
    branch_id: string | null;
    channel: string;
    kind: string;
    status: string;
  };

  if (row.branch_id) {
    const branchGuard = await requireBranchAccess(row.branch_id);
    if (branchGuard instanceof NextResponse) return branchGuard;
  }

  if (row.status !== "queued" && row.status !== "sending") {
    return NextResponse.json(
      {
        ok: false,
        reason: `cannot cancel — status is "${row.status}". Only queued/sending rows can be cancelled.`,
      },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();
  const upd = await admin
    .from("customer_notifications")
    .update({
      status: "cancelled",
      cancelled_at: now,
      cancelled_by: actorId,
      error_reason: body.reason ?? "cancelled by operator",
    })
    .eq("id", row.id)
    .in("status", ["queued", "sending"]); // race-safe
  if (upd.error) {
    return NextResponse.json(
      { ok: false, reason: upd.error.message },
      { status: 500 }
    );
  }

  // Audit.
  await admin.from("notification_resend_log").insert({
    notification_id: row.id,
    new_notification_id: null,
    action: "cancel",
    actor_id: actorId,
    reason: body.reason ?? null,
    request_ip: ip === "unknown" ? null : ip,
    customer_id: row.customer_id,
    branch_id: row.branch_id,
  });
  if (row.customer_id) {
    try {
      await admin.from("customer_activity").insert({
        customer_id: row.customer_id,
        branch_id: row.branch_id,
        kind: "notification_cancelled",
        payload: {
          notificationId: row.id,
          channel: row.channel,
          notificationKind: row.kind,
          actorId,
        },
      });
    } catch {}
  }

  return NextResponse.json({
    ok: true,
    notificationId: row.id,
    status: "cancelled",
  });
}
