// POST /api/admin/dashboard/refresh-snapshot — refresh
// public.dashboard_daily_snapshot via the SECURITY DEFINER SQL function.
//
// Owner / hq_admin only. Calls public.refresh_dashboard_daily_snapshot()
// which is grant-execute-to-service_role at migration time, so the admin
// client (service-role) does the actual refresh. The matview's concurrent
// path requires the unique index we created in migration 20260531.
//
// The route also fires the future cron path: GET works with a Bearer
// CRON_SECRET token, so the same matview refresh can be scheduled without
// inventing a parallel endpoint.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { refreshDashboardSnapshot } from "@/lib/aggregationService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < 16) return false;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length).trim() === secret;
}

async function handle(req: Request, allowCron: boolean) {
  if (allowCron && isCronAuthorized(req)) {
    const result = await refreshDashboardSnapshot();
    return NextResponse.json({ actorId: "cron", ...result });
  }
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;
  const result = await refreshDashboardSnapshot();
  return NextResponse.json({ actorId: profile.id, ...result });
}

export async function POST(req: Request) {
  return handle(req, false);
}

// Allow cron schedulers to GET this endpoint with a Bearer secret. Vercel
// Cron in particular only supports GET on cron-targeted routes.
export async function GET(req: Request) {
  return handle(req, true);
}
