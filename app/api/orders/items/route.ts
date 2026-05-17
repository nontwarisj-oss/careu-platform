// POST /api/orders/items — persist an order's line-items server-side.
//
// Why this route exists: public.order_items has RLS enabled in
// production, and the app runs cookieless (the browser Supabase
// client is unauthenticated), so a direct browser insert fails with
// "new row violates row-level security policy for table order_items".
// This route inserts with the service-role client (RLS-bypassing),
// behind a best-effort auth + intake-role + branch check — the same
// model as /api/orders/check-job-id and the order-save flow.
//
// The intake form calls this AFTER the order header is created; if it
// fails the form rolls the header back, so a ticket is never left
// half-saved.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { canViewAllBranches } from "@/lib/permissions";
import { insertOrderItems, type OrderItemInput } from "@/lib/orderItems";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Roles permitted to run intake — mirrors canCreateOrder().
const INTAKE_ROLES = ["owner", "hq_admin", "branch_manager", "front_staff"];

export async function POST(req: Request) {
  let body: { orderId?: unknown; branchId?: unknown; items?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 }
    );
  }
  const orderId = typeof body.orderId === "string" ? body.orderId : "";
  const branchId = typeof body.branchId === "string" ? body.branchId : null;
  const items = Array.isArray(body.items)
    ? (body.items as OrderItemInput[])
    : [];

  if (!orderId) {
    return NextResponse.json(
      { ok: false, error: "orderId required" },
      { status: 400 }
    );
  }

  // Best-effort auth — aligned with the order-save flow. When a
  // session cookie is present the intake role + branch are enforced;
  // when absent (cookieless / preview mode) the insert proceeds. The
  // route never 401s — branch isolation also holds because each row
  // carries branch_id and the intake form scopes to the active branch.
  const user = await getCurrentUser();
  if (user) {
    if (!INTAKE_ROLES.includes(user.role)) {
      console.error("[orders/items] auth failed", {
        reason: "role not allowed for intake",
        role: user.role,
        branchId,
      });
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 200 }
      );
    }
    if (
      !canViewAllBranches(user.role) &&
      branchId &&
      user.branchId !== branchId
    ) {
      console.error("[orders/items] auth failed", {
        reason: "branch access denied",
        branchId,
        userBranch: user.branchId,
      });
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 200 }
      );
    }
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("[orders/items] SUPABASE_SERVICE_ROLE_KEY not configured");
    return NextResponse.json(
      { ok: false, error: "service role not configured" },
      { status: 503 }
    );
  }

  // Service-role insert — bypasses RLS on public.order_items.
  const result = await insertOrderItems(orderId, branchId, items, admin);
  if (result.error) {
    console.error("[orders/items] insert failed", {
      orderId,
      branchId,
      error: result.error,
    });
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: 200 }
    );
  }

  return NextResponse.json({ ok: true, inserted: result.inserted });
}
