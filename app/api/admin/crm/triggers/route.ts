// GET /api/admin/crm/triggers — recent retention trigger jobs with
// explainability fields.
//
// Phase 19 surface: the operator answer to "why did this customer
// get this message?". Reads retention_trigger_jobs joined with
// customer names + branch override metadata.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
  ]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;
  const role = profile.role ?? "owner";
  const branchCode = profile.branchCode ?? null;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? 100), 10),
    500
  );
  const statusFilter = url.searchParams.get("status") ?? "";
  const kindFilter = url.searchParams.get("kind") ?? "";

  let q = admin
    .from("retention_trigger_jobs")
    .select(
      "id, customer_id, trigger_kind, channel, status, skip_reason, fired_reason, notification_id, branch_id, created_at, processed_at"
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (statusFilter) q = q.eq("status", statusFilter);
  if (kindFilter) q = q.eq("trigger_kind", kindFilter);
  if (role === "branch_manager" && branchCode) {
    q = q.eq("branch_id", branchCode);
  }
  const res = await q;
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  const rows = (res.data ?? []) as Array<{
    id: string;
    customer_id: string;
    trigger_kind: string;
    channel: string;
    status: string;
    skip_reason: string | null;
    fired_reason: string | null;
    notification_id: string | null;
    branch_id: string | null;
    created_at: string;
    processed_at: string | null;
  }>;

  // Enrich with customer name (one lookup per page is fine at limit ≤ 500).
  const customerIds = Array.from(new Set(rows.map((r) => r.customer_id)));
  let nameMap = new Map<string, string | null>();
  if (customerIds.length > 0) {
    const cust = await admin
      .from("customers")
      .select("id, name")
      .in("id", customerIds);
    ((cust.data ?? []) as Array<{ id: string; name: string | null }>).forEach((c) =>
      nameMap.set(c.id, c.name)
    );
  }

  return NextResponse.json({
    ok: true,
    triggers: rows.map((r) => ({
      ...r,
      customer_name: nameMap.get(r.customer_id) ?? null,
    })),
  });
}
