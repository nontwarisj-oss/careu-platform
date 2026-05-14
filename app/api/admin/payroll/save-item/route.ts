// POST /api/admin/payroll/save-item — upsert one technician_payroll_items row.
//
// Owner / hq_admin only. Body shape mirrors UpsertItemInput in payrollService.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { upsertPayrollItem } from "@/lib/payrollService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  payrollPeriodId?: string;
  technicianProfileId?: string;
  baseWage?: number;
  dailyWageSnapshot?: number | null;
  targetMultiplierSnapshot?: number | null;
  daysWorked?: number;
  productionValue?: number;
  targetValue?: number;
  performanceRatio?: number;
  bonusAmount?: number;
  /** Optional — auto-suggested bonus from lib/bonusEngine.ts. The service
   *  layer recomputes if absent so this is just an audit-trail hint. */
  bonusSuggested?: number | null;
  bonusRuleVersion?: string | null;
  deductionAmount?: number;
  notes?: string | null;
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
  if (!body.payrollPeriodId || !body.technicianProfileId) {
    return NextResponse.json(
      { ok: false, reason: "Missing payrollPeriodId or technicianProfileId" },
      { status: 400 }
    );
  }
  const res = await upsertPayrollItem({
    payrollPeriodId: body.payrollPeriodId,
    technicianProfileId: body.technicianProfileId,
    baseWage: Number(body.baseWage ?? 0),
    dailyWageSnapshot:
      body.dailyWageSnapshot === undefined
        ? null
        : Number(body.dailyWageSnapshot ?? 0),
    targetMultiplierSnapshot:
      body.targetMultiplierSnapshot === undefined
        ? null
        : Number(body.targetMultiplierSnapshot ?? 0),
    daysWorked: Number(body.daysWorked ?? 0),
    productionValue: Number(body.productionValue ?? 0),
    targetValue: Number(body.targetValue ?? 0),
    performanceRatio: Number(body.performanceRatio ?? 0),
    bonusAmount: Number(body.bonusAmount ?? 0),
    bonusSuggested:
      body.bonusSuggested === undefined ? null : Number(body.bonusSuggested ?? 0),
    bonusRuleVersion: body.bonusRuleVersion ?? null,
    deductionAmount: Number(body.deductionAmount ?? 0),
    notes: body.notes ?? null,
    actorId: profile.id,
  });
  if (!res.ok) {
    return NextResponse.json(res, { status: 400 });
  }
  return NextResponse.json(res);
}
