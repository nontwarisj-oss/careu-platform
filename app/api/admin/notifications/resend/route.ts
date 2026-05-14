// POST /api/admin/notifications/resend — manually re-queue a single
// notification.
//
// Use cases:
//   • A failed/dead_letter row that the operator wants to retry now
//     after fixing the provider config.
//   • A delivered/sent row that the customer didn't see (e.g. dropped
//     SMS, customer asked again at the counter) — operator clicks
//     "resend" and we make a fresh queue row.
//
// What it does:
//   1. Loads the original notification row + the operator's branch
//      access (owner/hq_admin pass; branch_manager/front_staff must
//      own the row's branch).
//   2. Creates a NEW row in customer_notifications with the same
//      payload, but resent_from = original.id, status='queued',
//      send_after=now, attempts=0.
//   3. Writes notification_resend_log + customer_activity rows.
//
// The dispatch worker picks up the new row on the next tick — the
// same retry / backoff / rate-limit logic applies.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "admin-resend",
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

  const orig = await admin
    .from("customer_notifications")
    .select(
      "id, customer_id, branch_id, channel, kind, payload, status, attempts, sent_at, delivered_at"
    )
    .eq("id", id)
    .maybeSingle();
  if (orig.error || !orig.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบ notification" },
      { status: 404 }
    );
  }
  const row = orig.data as {
    id: string;
    customer_id: string | null;
    branch_id: string | null;
    channel: string;
    kind: string;
    payload: Record<string, unknown>;
    status: string;
    attempts: number;
    sent_at: string | null;
    delivered_at: string | null;
  };

  if (row.branch_id) {
    const branchGuard = await requireBranchAccess(row.branch_id);
    if (branchGuard instanceof NextResponse) return branchGuard;
  }

  // Create the new queue row. We carry the SAME payload (body +
  // recipient address) so the dispatcher renders the same content;
  // resending a Job's "ready_for_pickup" message a day later does the
  // right thing because the payload was rendered at enqueue time, not
  // at dispatch time.
  const ins = await admin
    .from("customer_notifications")
    .insert({
      customer_id: row.customer_id,
      branch_id: row.branch_id,
      channel: row.channel,
      kind: row.kind,
      payload: row.payload ?? {},
      status: "queued",
      send_after: new Date().toISOString(),
      attempts: 0,
      created_by: actorId,
      resent_from: row.id,
    })
    .select("id, created_at")
    .single();
  if (ins.error || !ins.data) {
    return NextResponse.json(
      { ok: false, reason: ins.error?.message ?? "Insert failed" },
      { status: 500 }
    );
  }
  const newId = (ins.data as { id: string }).id;

  // Audit. Two log surfaces:
  //  • notification_resend_log — operator-visible "who clicked what"
  //  • customer_activity      — customer-visible "we resent your X"
  const action =
    row.status === "dead_letter"
      ? "dead_letter_retry"
      : "resend";
  await admin.from("notification_resend_log").insert({
    notification_id: row.id,
    new_notification_id: newId,
    action,
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
        kind: "notification_resent",
        payload: {
          originalId: row.id,
          newId,
          channel: row.channel,
          notificationKind: row.kind,
          actorId,
        },
      });
    } catch {
      // Best-effort.
    }
  }

  return NextResponse.json({
    ok: true,
    originalId: row.id,
    newNotificationId: newId,
    action,
  });
}
