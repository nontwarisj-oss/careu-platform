// POST /api/orders/check-job-id — server-side Job ID availability check.
//
// Why this route exists: the browser Supabase client cannot SELECT
// from `orders` under Row Level Security, so the intake form's live
// duplicate check failed in the browser. This route runs the lookup
// with the service-role client (RLS-bypassing) so the check is
// reliable.
//
// Auth model — aligned with the working order-save flow:
//   createSmartOrder (the order save that actually works in
//   production) does a direct browser insert with NO server-side
//   auth gate. The platform's session is an HMAC `careu_session`
//   cookie issued by LINE login (lib/session.ts); until that login
//   is configured the app runs cookieless and the client role
//   contexts default to a working role. A hard requireRole()
//   therefore 401s on every request in that state — which is exactly
//   what made this route fail in production.
//
//   So auth here is BEST-EFFORT: when a valid session cookie is
//   present we enforce the intake role + branch; when it is absent
//   we proceed (the intake page is already client-gated and this is
//   a low-sensitivity count read). The route NEVER returns 401 — an
//   auth problem comes back as { ok:false, state:"error" } so the
//   form shows amber, never a false "duplicate".
//
// Care U only: Ezy Repair auto-generates its Job ID, so the route
// returns "idle" for it.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { canViewAllBranches } from "@/lib/permissions";
import { normalizeJobId } from "@/lib/jobId";
import { SESSION_COOKIE_NAME } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Roles permitted to run intake — mirrors canCreateOrder().
const INTAKE_ROLES = ["owner", "hq_admin", "branch_manager", "front_staff"];

// A Care U Job ID counts as a "duplicate" only when the same id was
// used in this branch within this many days — an id used longer ago
// is free to reuse (a Care U job normally finishes inside the
// window). Enforced here in app logic: a rolling window cannot be a
// DB constraint (a partial index predicate must be IMMUTABLE, so it
// cannot reference now()). See migration 20260556.
const JOB_ID_DUPLICATE_WINDOW_DAYS = 45;

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
  // 1. Parse body first so branchId/businessType are available for logs.
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

  // 2. Best-effort auth — see the header note. getCurrentUser() only
  //    decodes the signed cookie (no DB round-trip), so it has far
  //    fewer failure modes than the previous requireRole() guard, and
  //    a missing session never 401s the form.
  const cookieStore = await cookies();
  const hasCookie = !!cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const user = await getCurrentUser();

  if (user) {
    if (!INTAKE_ROLES.includes(user.role)) {
      console.error("[check-job-id] auth failed", {
        reason: "role not allowed for intake",
        hasCookie,
        branchId,
        businessType,
      });
      return reply({ ok: false, state: "error", reason: "unauthorized" });
    }
    // Branch protection: a branch-scoped role may only check its own
    // branch. orders.branch_id, the posted branchId and the session
    // cookie's branchId are all the same branch code slug.
    if (!canViewAllBranches(user.role) && user.branchId !== branchId) {
      console.error("[check-job-id] auth failed", {
        reason: "branch access denied",
        hasCookie,
        branchId,
        businessType,
      });
      return reply({ ok: false, state: "error", reason: "unauthorized" });
    }
  } else {
    // No decodable session — proceed (aligned with the order-save
    // flow, which has no server auth). Logged so a missing
    // SESSION_SECRET / unfinished login config stays diagnosable.
    console.warn("[check-job-id] no session — proceeding", {
      reason: "no session cookie",
      hasCookie,
      branchId,
      businessType,
    });
  }

  // 3. Normalize. Empty/invalid id, or Ezy Repair (auto id) → idle.
  const normalizedJobId = normalizeJobId(rawJobId);
  if (!normalizedJobId || businessType !== "care_u") {
    return reply({ ok: true, state: "idle" });
  }

  // 4. Service-role lookup — bypasses RLS. Scoped to (branch_id,
  //    business_type, job_id) AND a 45-day rolling window on
  //    created_at: an id last used longer ago than that is free to
  //    reuse, so it does NOT count as a duplicate.
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

  const windowStart = new Date(
    Date.now() - JOB_ID_DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const res = await admin
    .from("orders")
    .select("id", { head: true, count: "exact" })
    .eq("job_id", normalizedJobId)
    .eq("branch_id", branchId)
    .eq("business_type", businessType)
    .gte("created_at", windowStart);

  if (res.error) {
    // A genuine server-side query failure — log the FULL error
    // (message + code + details + hint + the inputs) so the cause is
    // diagnosable from the server logs. NEVER return "duplicate": a
    // broken probe must not be reported as a taken Job ID.
    console.error("[check-job-id] orders lookup failed", {
      message: res.error.message,
      code: res.error.code,
      details: res.error.details,
      hint: res.error.hint,
      branchId,
      businessType,
      jobId: normalizedJobId,
    });
    return reply({
      ok: false,
      state: "error",
      normalizedJobId,
      reason: "lookup failed",
    });
  }

  // 5. Duplicate ONLY when the server confirms count > 0.
  const count = res.count ?? 0;
  return reply({
    ok: true,
    state: count > 0 ? "duplicate" : "available",
    normalizedJobId,
  });
}
