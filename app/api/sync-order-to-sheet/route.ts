// POST /api/sync-order-to-sheet — push one order row to the Front_Desk tab.
//
// This route is the HTTP front for `lib/orderSheetSync.ts::syncOrderToSheetCore`.
// The actual sheet write happens in the core helper so the retry worker
// (lib/retryWorker.ts) can call the exact same path without round-tripping
// through HTTP.
//
// Auth model:
//   1. requireRole — any signed-in role allowed (front_staff syncs on order
//      create; technician can re-sync their own orders).
//   2. requireBranchAccess(order.branch_id) — owner / hq_admin pass through;
//      branch-scoped roles must own the order's branch.
//
// Idempotency: the underlying writer dedups by Job ID (Front_Desk column B).
// A retry of the same order updates the existing row in place rather than
// inserting a duplicate.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { syncOrderToSheetCore } from "@/lib/orderSheetSync";
import { logSyncFailure } from "@/lib/syncFailures";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SHEET_TARGET = process.env.GOOGLE_SHEET_ORDER_TAB ?? "Front_Desk";

export async function POST(req: Request) {
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
    "front_staff",
    "technician",
  ]);
  if (guarded instanceof NextResponse) return guarded;

  let body: { orderId?: string };
  try {
    body = (await req.json()) as { orderId?: string };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const orderId = body.orderId;
  if (!orderId) {
    return NextResponse.json(
      { ok: false, reason: "Missing orderId" },
      { status: 400 }
    );
  }

  // Pre-check branch ownership before doing any work. We need a single
  // round-trip to fetch branch_id; the core function does its own read but
  // gating before the sheet write keeps the failure surface clean.
  const admin = getSupabaseAdmin();
  if (admin) {
    const orderRes = await admin
      .from("orders")
      .select("branch_id")
      .eq("id", orderId)
      .maybeSingle();
    const branchCode =
      orderRes.data &&
      typeof (orderRes.data as { branch_id?: unknown }).branch_id === "string"
        ? (orderRes.data as { branch_id: string }).branch_id
        : null;
    if (branchCode) {
      const branchGuard = await requireBranchAccess(branchCode);
      if (branchGuard instanceof NextResponse) return branchGuard;
    }
  }

  const result = await syncOrderToSheetCore(orderId);

  if (!result.ok) {
    logSyncFailure({
      kind: "order_to_sheet",
      targetId: orderId,
      reason: result.reason,
      payload: { sheet: SHEET_TARGET },
    });
    return NextResponse.json(
      {
        ok: false,
        reason: result.reason,
        sheet: SHEET_TARGET,
        orderId,
      },
      { status: result.status }
    );
  }

  return NextResponse.json({
    ok: true,
    sheet: result.sheet,
    rowIndex: result.rowIndex,
    formatted: result.formatted,
    mode: result.mode,
    orderId,
  });
}
