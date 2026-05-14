// POST /api/internal/attribute-order — server-side wrapper around
// lib/campaignAttribution.ts::attributeOrderToCampaign.
//
// Called by lib/orderCreate.ts after a successful order insert. The
// browser client doesn't have the service-role admin context, so
// the actual attribution logic runs on the server. Best-effort —
// the order is already created; this is pure post-processing.
//
// After campaign_response_metrics is written, also denormalises the
// campaign source onto orders.attribution_source_* so future
// queries don't always join.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { attributeOrderToCampaign } from "@/lib/campaignAttribution";
import { incrementFunnel } from "@/lib/campaignFunnel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  // Internal endpoint — any signed-in role allowed. The caller is
  // ops staff (intake / customer service / etc.) creating an order
  // and we accept their session as proof.
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
    "front_staff",
    "technician",
  ]);
  if (guarded instanceof NextResponse) return guarded;

  let body: {
    orderId?: string;
    customerId?: string;
    orderValue?: number;
    branchId?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  if (!body.orderId || !body.customerId) {
    return NextResponse.json(
      { ok: false, reason: "orderId + customerId required" },
      { status: 400 }
    );
  }

  const result = await attributeOrderToCampaign({
    orderId: body.orderId,
    customerId: body.customerId,
    orderValue: Number(body.orderValue ?? 0),
    branchId: body.branchId ?? null,
  });

  // Denormalise: when we attributed, write the source onto the
  // order row for fast queries + increment the funnel.
  if (result.ok && result.attributed && result.sourceKind && result.sourceId) {
    const admin = getSupabaseAdmin();
    if (admin) {
      const ch =
        result.sourceKind === "broadcast_send_job" ? "campaign" : "retention";
      try {
        await admin
          .from("orders")
          .update({
            attribution_source_kind: result.sourceKind,
            attribution_source_id: result.sourceId,
            attribution_channel: ch,
          })
          .eq("id", body.orderId);
      } catch {
        // best-effort
      }
      // Look up the original notification channel + branch to record
      // the funnel increment correctly.
      try {
        const ordRes = await admin
          .from("orders")
          .select("branch_id")
          .eq("id", body.orderId)
          .maybeSingle();
        const branchId =
          (ordRes.data as { branch_id: string | null } | null)?.branch_id ??
          body.branchId ??
          null;
        // We don't know the channel from the attribution alone; pick
        // a best guess via the most recent notification of the same
        // kind to this customer.
        const recent = await admin
          .from("customer_notifications")
          .select("channel")
          .eq("customer_id", body.customerId)
          .in("kind", ["broadcast", "retention"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const channel =
          (recent.data as { channel: string } | null)?.channel ?? "sms";
        await incrementFunnel({
          sourceKind: result.sourceKind,
          sourceId: result.sourceId,
          channel,
          branchId,
          stage: "order_created",
          revenueThb: Number(body.orderValue ?? 0),
        });
      } catch {
        // best-effort
      }
    }
  }

  return NextResponse.json({ ...result, ok: result.ok });
}
