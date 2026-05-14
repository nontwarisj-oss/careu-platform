// POST /api/admin/payroll/open-period — open (or fetch) the payroll period
// for (branch, year, month). Idempotent: re-pressing the "Open" button
// returns the same row.
//
// Owner / hq_admin only. Period lifecycle is HQ-controlled per role matrix.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { findOrCreatePeriod } from "@/lib/payrollService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { branchId?: string; year?: number; month?: number };

export async function POST(req: Request) {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  if (!body.branchId || !body.year || !body.month) {
    return NextResponse.json(
      { ok: false, reason: "Missing branchId / year / month" },
      { status: 400 }
    );
  }
  const res = await findOrCreatePeriod({
    branchId: body.branchId,
    year: body.year,
    month: body.month,
    actorId: profile.id,
  });
  if (!res.ok) {
    return NextResponse.json(res, { status: 400 });
  }
  return NextResponse.json(res);
}
