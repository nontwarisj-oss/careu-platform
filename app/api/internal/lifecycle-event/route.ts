// POST /api/internal/lifecycle-event — fire-and-forget trigger for
// lifecycle notifications.
//
// Called from the OPS client AFTER an order action lands. Validates
// the actor's role + branch ownership, then hands off to
// notifyLifecycleEvent. Always returns ok=true with a per-channel
// outcome list so the client can log success metrics; never throws.
//
// Why a separate route from the existing /api/sync-order-to-sheet:
//   • Sheet sync is a heavyweight write the staff actively waits on.
//     Notification enqueue is fast (single insert) and shouldn't block
//     the staff's flow.
//   • Sheet sync is gated to the create + status-change paths.
//     Notification triggers will eventually fire from more places
//     (payment received, overdue cron). One unified endpoint keeps the
//     surface small.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  notifyLifecycleEvent,
  type LifecycleEvent,
} from "@/lib/lifecycleNotifier";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_EVENTS: LifecycleEvent[] = [
  "order_created",
  "repair_started",
  "ready_for_pickup",
  "order_completed",
  "overdue_pickup",
  "payment_received",
];

export async function POST(req: Request) {
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
    "front_staff",
    "technician",
  ]);
  if (guarded instanceof NextResponse) return guarded;
  const actorId = guarded.profile.id;

  let body: { event?: string; orderId?: string };
  try {
    body = (await req.json()) as { event?: string; orderId?: string };
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
  if (!ALLOWED_EVENTS.includes(event as LifecycleEvent)) {
    return NextResponse.json(
      { ok: false, reason: `unknown event "${event}"` },
      { status: 400 }
    );
  }

  // Pre-check branch ownership. Same pattern as sync-order-to-sheet —
  // if the order isn't found the notifier returns a structured skip;
  // if the order exists but belongs to another branch, the role gate
  // blocks the operator here.
  const admin = getSupabaseAdmin();
  if (admin) {
    const orderRes = await admin
      .from("orders")
      .select("branch_id")
      .eq("id", orderId)
      .maybeSingle();
    const branchCode =
      orderRes.data &&
      typeof (orderRes.data as { branch_id?: unknown }).branch_id === "string"
        ? (orderRes.data as { branch_id: string }).branch_id
        : null;
    if (branchCode) {
      const branchGuard = await requireBranchAccess(branchCode);
      if (branchGuard instanceof NextResponse) return branchGuard;
    }
  }

  const result = await notifyLifecycleEvent({
    event: event as LifecycleEvent,
    orderId,
    actorId,
  });

  return NextResponse.json({ ...result, ok: result.ok });
}
