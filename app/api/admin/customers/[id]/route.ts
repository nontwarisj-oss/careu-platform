// GET /api/admin/customers/[id] — unified admin view of one customer.
//
// Owner / HQ see any customer; branch_manager / front_staff are scoped
// to customers attached to their own branch (via requireBranchAccess).
//
// Returns a single JSON document with:
//   • customer profile (incl. lifecycle_stage + retention_score + tier)
//   • notification preferences (or defaults)
//   • recent orders (10)
//   • recent activity (25)
//   • recent notifications (15)
//   • recent dispatch log entries (15)
//   • LINE link status
//   • upload counts
//
// No marketing automation; no broadcast. Pure read view.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
    "front_staff",
  ]);
  if (guarded instanceof NextResponse) return guarded;
  const { id } = await context.params;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  const customerRes = await admin
    .from("customers")
    .select(
      "id, name, phone, normalized_phone, email, branch_id, customer_type, customer_tier, lifecycle_stage, retention_score, total_orders, lifetime_spend, last_visit_at, created_at"
    )
    .eq("id", id)
    .maybeSingle();
  if (customerRes.error || !customerRes.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบลูกค้า" },
      { status: 404 }
    );
  }
  const customer = customerRes.data as Record<string, unknown> & {
    branch_id: string | null;
  };

  // Branch scope check — branch_manager / front_staff can only see
  // customers attached to their own branch.
  if (customer.branch_id) {
    const branchGuard = await requireBranchAccess(customer.branch_id);
    if (branchGuard instanceof NextResponse) return branchGuard;
  }

  // Fetch the customer's order id list first — needed for the upload
  // count and is also a useful sanity check. The other six reads run
  // in parallel afterwards.
  const orderIdsRes = await admin
    .from("orders")
    .select("id")
    .eq("customer_id", id);
  const orderIds = ((orderIdsRes.data ?? []) as Array<{ id: string }>).map(
    (o) => o.id
  );

  const [prefs, orders, activity, notifications, dispatchLog, lineLink, uploadCount, lineDelivery] =
    await Promise.all([
      admin
        .from("customer_notification_preferences")
        .select(
          "sms_enabled, line_enabled, email_enabled, pickup_reminders, order_status_alerts, payment_alerts, promotional, last_updated_at"
        )
        .eq("customer_id", id)
        .maybeSingle(),
      admin
        .from("orders")
        .select(
          "id, job_id, status, payment_status, service_name, item_name, price, due_date, created_at, branch_id"
        )
        .eq("customer_id", id)
        .order("created_at", { ascending: false })
        .limit(10),
      admin
        .from("customer_activity")
        .select("id, kind, payload, created_at, branch_id")
        .eq("customer_id", id)
        .order("created_at", { ascending: false })
        .limit(25),
      admin
        .from("customer_notifications")
        .select(
          "id, channel, kind, status, attempts, sent_at, error_reason, created_at"
        )
        .eq("customer_id", id)
        .order("created_at", { ascending: false })
        .limit(15),
      admin
        .from("notification_dispatch_log")
        .select(
          "id, channel, kind, outcome, retryable, attempt, latency_ms, provider, reason, created_at"
        )
        .eq("customer_id", id)
        .order("created_at", { ascending: false })
        .limit(15),
      admin
        .from("customer_line_links")
        .select(
          "id, line_user_id, display_name, consented_at, unsubscribed_at, created_at"
        )
        .eq("customer_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      orderIds.length === 0
        ? Promise.resolve({ count: 0 } as { count: number | null })
        : admin
            .from("order_attachments")
            .select("id", { count: "exact", head: true })
            .in("order_id", orderIds),
      admin
        .from("line_delivery_log")
        .select(
          "id, event_type, request_id, http_status, reason, created_at, details"
        )
        .eq("customer_id", id)
        .order("created_at", { ascending: false })
        .limit(15),
    ]);

  return NextResponse.json({
    ok: true,
    customer,
    prefs: prefs.data ?? null,
    orders: orders.data ?? [],
    activity: activity.data ?? [],
    notifications: notifications.data ?? [],
    dispatchLog: dispatchLog.data ?? [],
    lineLink: lineLink.data ?? null,
    uploadCount: uploadCount.count ?? 0,
    lineDelivery: lineDelivery.data ?? [],
  });
}
