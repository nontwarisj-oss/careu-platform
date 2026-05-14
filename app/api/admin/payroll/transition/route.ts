// POST /api/admin/payroll/transition — flip a period between
// open → finalized → paid. Idempotent on no-op transitions.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { finalizePeriod, markPeriodPaid } from "@/lib/payrollService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  periodId?: string;
  to?: "finalized" | "paid";
};

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
  if (!body.periodId || !body.to) {
    return NextResponse.json(
      { ok: false, reason: "Missing periodId or to" },
      { status: 400 }
    );
  }
  const res =
    body.to === "paid"
      ? await markPeriodPaid(body.periodId, profile.id)
      : await finalizePeriod(body.periodId, profile.id);
  if (!res.ok) {
    return NextResponse.json(res, { status: 400 });
  }
  return NextResponse.json(res);
}
