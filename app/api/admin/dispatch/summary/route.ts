// GET /api/admin/dispatch/summary — counts for the /admin/dispatch UI.
//
// Returns queue depth by status + recent failures so the admin can see
// "is the worker alive? is anything piling up?".

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function count(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  status: string
): Promise<number> {
  const { count } = await admin
    .from("customer_notifications")
    .select("id", { count: "exact", head: true })
    .eq("status", status);
  return count ?? 0;
}

export async function GET() {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  const [queued, sending, sent, failed, skipped] = await Promise.all([
    count(admin, "queued"),
    count(admin, "sending"),
    count(admin, "sent"),
    count(admin, "failed"),
    count(admin, "skipped"),
  ]);

  // Recent rows for the table view. 25 most-recent failures + 25 most-
  // recent queued so the operator can spot patterns at a glance.
  const failuresRes = await admin
    .from("customer_notifications")
    .select(
      "id, channel, kind, status, attempts, send_after, sent_at, error_reason, customer_id, branch_id, created_at"
    )
    .in("status", ["failed"])
    .order("created_at", { ascending: false })
    .limit(25);
  const queuedRes = await admin
    .from("customer_notifications")
    .select(
      "id, channel, kind, status, attempts, send_after, customer_id, branch_id, created_at"
    )
    .in("status", ["queued", "sending"])
    .order("send_after", { ascending: true })
    .limit(25);

  return NextResponse.json({
    ok: true,
    counts: { queued, sending, sent, failed, skipped },
    recentFailures: failuresRes.data ?? [],
    pendingPreview: queuedRes.data ?? [],
    smsProvider: (process.env.SMS_PROVIDER ?? "console").toLowerCase(),
  });
}
