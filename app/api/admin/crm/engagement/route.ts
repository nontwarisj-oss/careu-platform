// GET /api/admin/crm/engagement — engagement dashboard payload.
//
// Owner / HQ / branch_manager. Branch scoping enforced at the
// customer pool level — branch_manager sees only their branch's
// engagement metrics.
//
// Returns:
//   • lifecycleBreakdown   — counts per status
//   • retentionTrend       — 30-day repeat-customer % series
//   • churnRiskCount       — at_risk + dormant
//   • topReturning         — customers with highest total_orders/spend
//   • triggerSummary       — last 24h per-kind counts
//   • branchComparison     — per-branch lifecycle breakdown (owner/HQ only)

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
  ]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;
  const isAll = profile.role === "owner" || profile.role === "hq_admin";
  const branchCode = profile.branchCode ?? null;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  // ----- Lifecycle breakdown -----
  const lifecycleBreakdown: Record<string, number> = {
    new: 0,
    active: 0,
    repeat: 0,
    loyal: 0,
    at_risk: 0,
    dormant: 0,
    churned: 0,
  };
  for (const status of Object.keys(lifecycleBreakdown)) {
    let q = admin
      .from("customer_lifecycle_status")
      .select("customer_id", { count: "exact", head: true })
      .eq("status", status);
    if (!isAll && branchCode) {
      q = q.eq("branch_id", branchCode);
    }
    const r = await q;
    lifecycleBreakdown[status] = r.count ?? 0;
  }

  // ----- Retention trend (30 days) -----
  // For each of the last 30 days, count customers with total_orders >= 2
  // who had a sent SMS/LINE/email — a rough "repeat-customer reach"
  // metric. Phase 18 keeps this simple; the dashboard can iterate.
  const trend: Array<{ date: string; repeat: number; total: number }> = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    let q = admin
      .from("customer_engagement_daily")
      .select("customer_id, total_orders", { count: "exact", head: true })
      .eq("metric_date", day);
    if (!isAll && branchCode) {
      // metric_date table doesn't carry branch_id directly; join via
      // customers. For Phase 18 we approximate by querying through
      // customer_lifecycle_status instead.
      q = q;
    }
    const total = await q;
    const repeat = await admin
      .from("customer_engagement_daily")
      .select("customer_id", { count: "exact", head: true })
      .eq("metric_date", day)
      .gte("total_orders", 2);
    trend.push({
      date: day,
      total: total.count ?? 0,
      repeat: repeat.count ?? 0,
    });
  }

  // ----- Churn risk / dormant count -----
  const churnRiskCount =
    lifecycleBreakdown.at_risk + lifecycleBreakdown.dormant;

  // ----- Top returning customers -----
  let topQ = admin
    .from("customer_lifecycle_status")
    .select(
      "customer_id, status, total_orders, total_spend, branch_id, computed_at, reason"
    )
    .in("status", ["repeat", "loyal"])
    .order("total_orders", { ascending: false })
    .limit(15);
  if (!isAll && branchCode) topQ = topQ.eq("branch_id", branchCode);
  const topRes = await topQ;
  const top = (topRes.data ?? []) as Array<{
    customer_id: string;
    status: string;
    total_orders: number;
    total_spend: number;
    branch_id: string | null;
  }>;

  // Enrich with customer name.
  const customerIds = top.map((t) => t.customer_id);
  const namesRes =
    customerIds.length === 0
      ? { data: [] }
      : await admin
          .from("customers")
          .select("id, name")
          .in("id", customerIds);
  const nameMap = new Map<string, string | null>();
  ((namesRes.data ?? []) as Array<{ id: string; name: string | null }>).forEach(
    (r) => nameMap.set(r.id, r.name)
  );
  const topReturning = top.map((t) => ({
    customerId: t.customer_id,
    name: nameMap.get(t.customer_id) ?? null,
    status: t.status,
    totalOrders: t.total_orders,
    totalSpend: t.total_spend,
    branchId: t.branch_id,
  }));

  // ----- Trigger summary (last 24h) -----
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const triggerKinds = [
    "no_visit_x_days",
    "pickup_overdue",
    "inactive_vip",
    "high_spend_dormant",
    "birthday_month",
    "first_time_followup",
  ];
  const triggerSummary: Record<
    string,
    { fired: number; skipped: number; failed: number }
  > = {};
  for (const kind of triggerKinds) {
    const baseQ = admin
      .from("retention_trigger_jobs")
      .select("id", { count: "exact", head: true })
      .eq("trigger_kind", kind)
      .gte("created_at", since);
    const fired = await baseQ;
    const firedCount = fired.count ?? 0;
    const skippedRes = await admin
      .from("retention_trigger_jobs")
      .select("id", { count: "exact", head: true })
      .eq("trigger_kind", kind)
      .eq("status", "skipped")
      .gte("created_at", since);
    const failedRes = await admin
      .from("retention_trigger_jobs")
      .select("id", { count: "exact", head: true })
      .eq("trigger_kind", kind)
      .eq("status", "failed")
      .gte("created_at", since);
    triggerSummary[kind] = {
      fired: firedCount,
      skipped: skippedRes.count ?? 0,
      failed: failedRes.count ?? 0,
    };
  }

  // ----- Branch comparison (owner/HQ only) -----
  let branchComparison: Array<{
    branchId: string;
    new: number;
    active: number;
    repeat: number;
    loyal: number;
    at_risk: number;
    dormant: number;
    churned: number;
  }> = [];
  if (isAll) {
    const groups = await admin
      .from("customer_lifecycle_status")
      .select("branch_id, status")
      .limit(20000);
    if (!groups.error && groups.data) {
      const grouped = new Map<
        string,
        Record<string, number>
      >();
      (groups.data as Array<{ branch_id: string | null; status: string }>).forEach(
        (r) => {
          const key = r.branch_id ?? "(no-branch)";
          const slot = grouped.get(key) ?? {
            new: 0,
            active: 0,
            repeat: 0,
            loyal: 0,
            at_risk: 0,
            dormant: 0,
            churned: 0,
          };
          if (r.status in slot) slot[r.status] += 1;
          grouped.set(key, slot);
        }
      );
      branchComparison = Array.from(grouped.entries()).map(([k, v]) => ({
        branchId: k,
        new: v.new ?? 0,
        active: v.active ?? 0,
        repeat: v.repeat ?? 0,
        loyal: v.loyal ?? 0,
        at_risk: v.at_risk ?? 0,
        dormant: v.dormant ?? 0,
        churned: v.churned ?? 0,
      }));
    }
  }

  return NextResponse.json({
    ok: true,
    lifecycleBreakdown,
    retentionTrend: trend,
    churnRiskCount,
    topReturning,
    triggerSummary,
    branchComparison,
    generatedAt: new Date().toISOString(),
  });
}
