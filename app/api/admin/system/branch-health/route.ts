// GET /api/admin/system/branch-health — per-branch operational health.
//
// Phase 24. Owner / hq_admin see every branch; branch_manager sees
// only their own branch (scoped server-side, not trusted from the
// request).

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { computeBranchHealth } from "@/lib/branchHealth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
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

  const branches = await computeBranchHealth({ branchId: branchCode });
  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    scope: branchCode ? "branch" : "all",
    branches,
  });
}
