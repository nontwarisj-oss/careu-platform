// POST /api/admin/reconcile/run — manual reconcile trigger.
//
// Auth model:
//   • requireRole(owner / hq_admin / branch_manager).
//   • Branch_manager's branchCode is forced to their profile.branchCode,
//     mirroring the run-worker route pattern.
//
// Behaviour:
//   • Calls runReconcileTick({ actorId: profile.id, branchCode }).
//   • Writes a reconcile_runs heartbeat (in the service itself).
//   • Detected mismatches are enqueued as sync_failures rows so the
//     existing /admin/recovery UI surfaces and resolves them.
//
// Body (all optional):
//   { branchCode?: string | null, lookbackDays?: number, dryRun?: boolean }

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { runReconcileTick } from "@/lib/reconcile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  branchCode?: string | null;
  lookbackDays?: number;
  dryRun?: boolean;
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

  let branchCode: string | null = null;
  if (profile.role === "branch_manager") {
    if (!profile.branchCode) {
      return NextResponse.json(
        {
          ok: false,
          reason:
            "บัญชี branch_manager ของคุณยังไม่ผูกสาขา — ติดต่อ Owner ก่อนใช้งาน reconcile",
        },
        { status: 403 }
      );
    }
    branchCode = profile.branchCode;
  } else {
    branchCode = body.branchCode ?? null;
  }

  const result = await runReconcileTick({
    branchCode,
    lookbackDays: body.lookbackDays,
    dryRun: !!body.dryRun,
    actorId: profile.id,
  });

  if (!result.ok) {
    return NextResponse.json(result, { status: 503 });
  }
  return NextResponse.json({
    ...result,
    actorRole: profile.role,
    scopedBranch: branchCode,
  });
}
