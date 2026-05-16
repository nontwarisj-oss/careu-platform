// POST /api/admin/customer-tier/refresh — recompute customer tier + insight
// columns (lifetime_spend / last_visit_at / primary_branch_id /
// customer_tier / total_orders / latest_service).
//
// Auth model:
//   • owner / hq_admin / branch_manager. branch_manager's branchCode is
//     forced to their profile.branchCode (no cross-branch refresh).
//
// Body shapes:
//   { customerId: string }                  — refresh one customer
//   { branchCode?: string | null, limit? }  — refresh all customers in a
//                                             branch (owner / HQ may omit
//                                             to recompute every branch)
//
// Returns the per-customer outcome OR the batch summary.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { refreshCustomerTier } from "@/lib/customerTierService";
import { recalcCustomerStats } from "@/lib/customerRecalc";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  customerId?: string;
  branchCode?: string | null;
  limit?: number;
};

export async function POST(req: Request) {
  const guarded = await requireRole(["owner", "hq_admin", "branch_manager"]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  // Single-customer refresh.
  if (body.customerId) {
    const result = await refreshCustomerTier(body.customerId);
    if (!result.ok) {
      return NextResponse.json(result, { status: 500 });
    }
    return NextResponse.json(result);
  }

  // Batch refresh.
  let branchCode: string | null = null;
  if (profile.role === "branch_manager") {
    if (!profile.branchCode) {
      return NextResponse.json(
        {
          ok: false,
          reason: "บัญชี branch_manager ของคุณยังไม่ผูกสาขา",
        },
        { status: 403 }
      );
    }
    branchCode = profile.branchCode;
  } else {
    branchCode = body.branchCode ?? null;
  }

  // Batch path — recalcCustomerStats recomputes visits + spend + tier with
  // the robust order matcher (id → phone → name) and excludes cancelled
  // orders, so long-standing customers are no longer mis-classified "new".
  const summary = await recalcCustomerStats(branchCode, { limit: body.limit });
  return NextResponse.json({ ...summary, scopedBranch: branchCode });
}
