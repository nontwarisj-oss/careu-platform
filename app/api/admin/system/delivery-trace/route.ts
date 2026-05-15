// GET /api/admin/system/delivery-trace — operator delivery search.
//
// Phase 25. Searches customer_notifications by any of:
//   • q            — provider message id (exact) OR customer id (uuid)
//   • phone        — resolves customers by normalized_phone
//   • status       — queued / sent / delivered / failed / ...
//   • broadcastJobId — campaign scope (payload.broadcastJobId)
//
// Each result row carries the provider response, retry count, and
// final outcome — the operator clicks through to the full timeline.
//
// owner / hq_admin see all branches; branch_manager is scoped to
// their own branch server-side.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const phone = (url.searchParams.get("phone") ?? "").trim();
  const status = (url.searchParams.get("status") ?? "").trim();
  const broadcastJobId = (url.searchParams.get("broadcastJobId") ?? "").trim();

  let query = admin
    .from("customer_notifications")
    .select(
      "id, customer_id, branch_id, channel, kind, status, attempts, provider_message_id, last_provider_status, error_reason, created_at, sent_at, delivered_at"
    )
    .order("created_at", { ascending: false })
    .limit(80);

  if (branchCode) query = query.eq("branch_id", branchCode);
  if (status) query = query.eq("status", status);
  if (broadcastJobId) query = query.eq("payload->>broadcastJobId", broadcastJobId);

  // Free-text q: a uuid → customer id; anything else → provider msg id.
  if (q) {
    if (UUID_RE.test(q)) query = query.eq("customer_id", q);
    else query = query.eq("provider_message_id", q);
  }

  // Phone search → resolve customer ids first.
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    const custRes = await admin
      .from("customers")
      .select("id")
      .or(`normalized_phone.ilike.%${digits}%,phone.ilike.%${digits}%`)
      .limit(50);
    const ids = ((custRes.data ?? []) as Array<{ id: string }>).map(
      (c) => c.id
    );
    if (ids.length === 0) {
      return NextResponse.json({ ok: true, results: [], matched: 0 });
    }
    query = query.in("customer_id", ids);
  }

  const res = await query;
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  const rows = (res.data ?? []) as Array<Record<string, unknown>>;
  return NextResponse.json({
    ok: true,
    matched: rows.length,
    results: rows,
  });
}
