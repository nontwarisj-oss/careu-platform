// POST /api/orders/check-job-id — server-side Job ID availability check.
//
// Why this route exists: the browser Supabase client cannot SELECT
// from `orders` under Row Level Security, so the intake form's live
// duplicate check failed in production and surfaced as the amber
// "ยังตรวจสอบ Job ID ไม่สำเร็จ" error. This route runs the lookup with
// the service-role client (RLS-bypassing) behind an auth +
// intake-role + branch-access gate, so the check is reliable and
// never leaks another branch's data.
//
// Care U only: Ezy Repair auto-generates its Job ID server-side, so
// there is nothing to check — the route returns "idle" for it.
//
// A failed lookup returns state "error" — NEVER "duplicate": staff
// must not be told an id is taken just because the probe broke.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { canViewAllBranches } from "@/lib/permissions";
import { normalizeJobId } from "@/lib/jobId";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CheckState = "idle" | "available" | "duplicate" | "error";

type CheckResponse = {
  ok: boolean;
  state: CheckState;
  normalizedJobId?: string;
  reason?: string;
};

function reply(body: CheckResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  // 1. Authenticated + intake-role gate (owner / hq_admin /
  //    branch_manager / front_staff — mirrors canCreateOrder()).
  //    Auth failures come back as a non-blocking "error" state so the
  //    form shows amber, never a false "available".
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
    "front_staff",
  ]);
  if (guarded instanceof NextResponse) {
    return reply(
      { ok: false, state: "error", reason: "unauthorized" },
      guarded.status
    );
  }
  const { profile } = guarded;

  // 2. Parse body.
  let body: { jobId?: unknown; branchId?: unknown; businessType?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return reply(
      { ok: false, state: "error", reason: "invalid JSON body" },
      400
    );
  }
  const rawJobId = typeof body.jobId === "string" ? body.jobId : "";
  const branchId = typeof body.branchId === "string" ? body.branchId : "";
  const businessType =
    body.businessType === "ezy_repair" ? "ezy_repair" : "care_u";

  if (!branchId) {
    return reply(
      { ok: false, state: "error", reason: "branchId required" },
      400
    );
  }

  // 3. Branch access — branch-scoped roles may only check their own
  //    branch. orders.branch_id stores the branch code slug, which is
  //    also what profile.branchCode holds and what the form sends.
  if (!canViewAllBranches(profile.role) && profile.branchCode !== branchId) {
    return reply(
      { ok: false, state: "error", reason: "branch access denied" },
      403
    );
  }

  // 4. Normalize. Empty/invalid id, or Ezy Repair (auto id) → nothing
  //    to check.
  const normalizedJobId = normalizeJobId(rawJobId);
  if (!normalizedJobId || businessType !== "care_u") {
    return reply({ ok: true, state: "idle" });
  }

  // 5. Service-role lookup — bypasses RLS, scoped to the same triple
  //    as the unique index (branch_id, business_type, job_id).
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("[check-job-id] SUPABASE_SERVICE_ROLE_KEY not configured");
    return reply(
      {
        ok: false,
        state: "error",
        normalizedJobId,
        reason: "service role not configured",
      },
      503
    );
  }

  const res = await admin
    .from("orders")
    .select("id", { head: true, count: "exact" })
    .eq("job_id", normalizedJobId)
    .eq("branch_id", branchId)
    .eq("business_type", businessType);

  if (res.error) {
    // A genuine server-side query failure — log it and return "error".
    // NEVER "duplicate": a broken probe must not be reported as a
    // taken Job ID.
    console.error("[check-job-id] orders lookup failed:", res.error.message);
    return reply({
      ok: false,
      state: "error",
      normalizedJobId,
      reason: "lookup failed",
    });
  }

  // 6. Duplicate ONLY when the server confirms count > 0.
  const count = res.count ?? 0;
  return reply({
    ok: true,
    state: count > 0 ? "duplicate" : "available",
    normalizedJobId,
  });
}
