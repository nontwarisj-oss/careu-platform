// GET /api/admin/dashboard/summary — snapshot-backed dashboard KPIs.
//
// Why a server route: public.dashboard_daily_snapshot is granted to
// `service_role` only (RLS doesn't apply to materialised views, so we
// revoke `authenticated` reads). The dashboard page calls this endpoint
// instead of querying the matview directly.
//
// Branch isolation:
//   • owner / hq_admin may set ?branchCode= (or omit for all branches).
//   • branch_manager / front_staff / technician have branchCode forced
//     to their profile.branchCode — the body / query is ignored.
//   • No anon access.
//
// Fallback: if the snapshot has zero rows (fresh deploy, refresh job
// hasn't run yet), the route falls back to a live aggregation over
// `orders` for the last 30 days so the dashboard never shows empty
// summary cards. The response includes `usingSnapshot: bool` so the
// page can display a "live (snapshot empty)" hint when appropriate.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  fetchBranchSalesSummary,
  type DailySnapshotRow,
} from "@/lib/aggregationService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_LOOKBACK_DAYS = 30;

type SummaryTotals = {
  totalOrders: number;
  completedOrders: number;
  readyOrders: number;
  urgentOrders: number;
  revenue: number;
  paidRevenue: number;
  urgentFeeTotal: number;
  materialCostTotal: number;
  laborCostTotal: number;
};

function sumRows(rows: DailySnapshotRow[]): SummaryTotals {
  return rows.reduce<SummaryTotals>(
    (acc, r) => {
      acc.totalOrders += r.totalOrders;
      acc.completedOrders += r.completedOrders;
      acc.readyOrders += r.readyOrders;
      acc.urgentOrders += r.urgentOrders;
      acc.revenue += r.revenue;
      acc.paidRevenue += r.paidRevenue;
      acc.urgentFeeTotal += r.urgentFeeTotal;
      acc.materialCostTotal += r.materialCostTotal;
      acc.laborCostTotal += r.laborCostTotal;
      return acc;
    },
    {
      totalOrders: 0,
      completedOrders: 0,
      readyOrders: 0,
      urgentOrders: 0,
      revenue: 0,
      paidRevenue: 0,
      urgentFeeTotal: 0,
      materialCostTotal: 0,
      laborCostTotal: 0,
    }
  );
}

async function liveFallback(
  branchCode: string | null,
  lookbackDays: number
): Promise<{ totals: SummaryTotals; latestRowAt: string | null }> {
  const empty = {
    totals: sumRows([]),
    latestRowAt: null as string | null,
  };
  const admin = getSupabaseAdmin();
  if (!admin) return empty;
  const since = new Date(
    Date.now() - lookbackDays * 24 * 60 * 60 * 1000
  ).toISOString();
  let q = admin
    .from("orders")
    .select(
      "id, branch_id, status, price, payment_status, urgent, urgent_fee, material_cost, labor_cost, created_at"
    )
    .gte("created_at", since)
    .limit(5000);
  if (branchCode) q = q.eq("branch_id", branchCode);
  const { data, error } = await q;
  if (error || !data) return empty;
  const rows = data as Array<{
    id: string;
    status: string;
    price: number | string | null;
    payment_status: string | null;
    urgent: boolean | null;
    urgent_fee: number | string | null;
    material_cost: number | string | null;
    labor_cost: number | string | null;
    created_at: string;
  }>;
  let latestRowAt: string | null = null;
  const totals: SummaryTotals = {
    totalOrders: rows.length,
    completedOrders: 0,
    readyOrders: 0,
    urgentOrders: 0,
    revenue: 0,
    paidRevenue: 0,
    urgentFeeTotal: 0,
    materialCostTotal: 0,
    laborCostTotal: 0,
  };
  for (const r of rows) {
    if (r.status === "completed") {
      totals.completedOrders += 1;
      totals.revenue += Number(r.price ?? 0);
    }
    if (r.status === "ready-for-pickup") totals.readyOrders += 1;
    if (r.urgent === true) totals.urgentOrders += 1;
    if (r.payment_status === "paid") totals.paidRevenue += Number(r.price ?? 0);
    totals.urgentFeeTotal += Number(r.urgent_fee ?? 0);
    totals.materialCostTotal += Number(r.material_cost ?? 0);
    totals.laborCostTotal += Number(r.labor_cost ?? 0);
    if (!latestRowAt || r.created_at > latestRowAt) latestRowAt = r.created_at;
  }
  return { totals, latestRowAt };
}

export async function GET(req: Request) {
  // Any signed-in role may read summary for their visible scope.
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
    "front_staff",
    "technician",
  ]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;

  const url = new URL(req.url);
  const requestedBranch = url.searchParams.get("branchCode");
  const lookbackParam = Number(url.searchParams.get("lookbackDays") ?? "");
  const lookbackDays =
    Number.isFinite(lookbackParam) && lookbackParam > 0
      ? Math.min(Math.floor(lookbackParam), 90)
      : DEFAULT_LOOKBACK_DAYS;

  let branchCode: string | null = null;
  if (profile.role === "owner" || profile.role === "hq_admin") {
    branchCode = requestedBranch && requestedBranch !== "all" ? requestedBranch : null;
  } else {
    // Branch-scoped roles get their own branch — body/query is ignored
    // to prevent cross-branch peeking via the snapshot.
    branchCode = profile.branchCode ?? null;
    if (!branchCode) {
      return NextResponse.json(
        {
          ok: false,
          reason: "บัญชีของคุณยังไม่ผูกสาขา — ติดต่อ Owner",
        },
        { status: 403 }
      );
    }
  }

  const fromDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const toDate = new Date().toISOString().slice(0, 10);

  // Try snapshot first.
  const rows = await fetchBranchSalesSummary({
    branchCode,
    fromDate,
    toDate,
  });

  if (rows.length > 0) {
    const totals = sumRows(rows);
    // Latest work_date in the matview rows is the freshness signal.
    const latest = rows.reduce<string | null>(
      (acc, r) => (!acc || r.workDate > acc ? r.workDate : acc),
      null
    );
    return NextResponse.json({
      ok: true,
      usingSnapshot: true,
      branchCode,
      lookbackDays,
      totals,
      // Client-side bucketing (today / this month / last month) needs the
      // per-day rows. Keeping the response under ~90 rows × few-hundred-bytes
      // each so the payload stays small.
      rows,
      snapshotRefreshedAt: latest,
      rowCount: rows.length,
    });
  }

  // Fallback to a live read.
  const live = await liveFallback(branchCode, lookbackDays);
  return NextResponse.json({
    ok: true,
    usingSnapshot: false,
    branchCode,
    lookbackDays,
    totals: live.totals,
    snapshotRefreshedAt: null,
    /** Latest order timestamp from the live read — useful for "as of" labels
     *  when the matview is empty. */
    latestOrderAt: live.latestRowAt,
    rowCount: 0,
  });
}
