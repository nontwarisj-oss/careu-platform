// GET /api/admin/system/delivery-timeline?notificationId=... —
// the unified per-notification delivery audit trail.
//
// Phase 24. Read-only. owner / hq_admin / branch_manager / front_staff
// — the same operator roles that can read a customer's notifications.
// Branch isolation is enforced by the customer_notifications RLS that
// the timeline reader's queries inherit (service-role reads are
// gated by this route's role check).

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getNotificationTimeline } from "@/lib/deliveryTimeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
    "front_staff",
  ]);
  if (guarded instanceof NextResponse) return guarded;

  const url = new URL(req.url);
  const notificationId = url.searchParams.get("notificationId") ?? "";
  if (!notificationId) {
    return NextResponse.json(
      { ok: false, reason: "notificationId required" },
      { status: 400 }
    );
  }

  const timeline = await getNotificationTimeline(notificationId);
  if (!timeline) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบ notification" },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true, timeline });
}
