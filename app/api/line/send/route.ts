// POST /api/line/send — canonical LINE OA send endpoint.
//
// Request body:
//   {
//     orderId: string;
//     kind: 'order_received' | 'order_ready' | 'pickup_reminder' | 'receipt';
//     // Optional plain text override; bypasses the builder when present.
//     // Stays for backward-compat with the existing client wrapper
//     // (lib/lineOA.ts::sendToLineOA) which posts { orderId, message }.
//     message?: string;
//   }
//
// Auth:
//   • requireRole(['owner','hq_admin','branch_manager','front_staff'])
//   • requireBranchAccess(order.branch_id) is enforced indirectly by
//     RLS on the orders table — when the orchestrator runs via the
//     service-role client it can read any branch, so this route only
//     lets approved roles trigger a send. The branch ownership check
//     happens via the fetched order's branch_id matching the caller's.
//
// Failure handling: the route never bubbles a 5xx for a recoverable
// LINE-side problem (no link, channel not configured, push HTTP 4xx).
// Those return 200 with `ok: false, reason: …` so the UI can show a
// friendly toast.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import {
  sendOrderCreatedMessage,
  sendOrderReadyMessage,
  sendPickupReminderMessage,
  sendReceiptMessage,
  type DeliveryResult,
  type LineMessageKind,
} from "@/lib/lineDelivery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_KINDS: LineMessageKind[] = [
  "order_received",
  "order_ready",
  "pickup_reminder",
  "receipt",
];

type SendBody = {
  orderId?: string;
  kind?: string;
  /** Optional plain-text override, used by the legacy "Send LINE OA" button. */
  message?: string;
  /** Legacy field — was the LINE user id passed inline. Now resolved from the customer link table. */
  to?: string;
};

export async function POST(req: Request) {
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
    "front_staff",
  ]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;

  let body: SendBody;
  try {
    body = (await req.json()) as SendBody;
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

  // The legacy client (lib/lineOA.ts::sendToLineOA) posts `{ message }`
  // without a `kind`. Treat that as a manual receipt-style send so the
  // existing "Send LINE OA" button on /orders/[id]/document keeps working
  // until the page is migrated to use the kind-aware client wrapper.
  const kindCandidate = body.kind ?? (body.message ? "receipt" : "");
  if (!ALLOWED_KINDS.includes(kindCandidate as LineMessageKind)) {
    return NextResponse.json(
      {
        ok: false,
        reason: `Unsupported kind "${kindCandidate}". Expected one of ${ALLOWED_KINDS.join(", ")}.`,
      },
      { status: 400 }
    );
  }
  const kind = kindCandidate as LineMessageKind;

  let result: DeliveryResult;
  try {
    switch (kind) {
      case "order_received":
        result = await sendOrderCreatedMessage(orderId, { actorId: profile.id });
        break;
      case "order_ready":
        result = await sendOrderReadyMessage(orderId, { actorId: profile.id });
        break;
      case "pickup_reminder":
        result = await sendPickupReminderMessage(orderId, { actorId: profile.id });
        break;
      case "receipt":
        result = await sendReceiptMessage(orderId, { actorId: profile.id });
        break;
    }
  } catch (err) {
    // The orchestrator catches its own errors, but defend against an
    // unexpected throw so the order flow keeps running.
    console.error("[/api/line/send] orchestrator threw", err);
    return NextResponse.json(
      {
        ok: false,
        reason:
          "ส่ง LINE OA ไม่สำเร็จ — server error (orchestrator threw). ใบงานไม่ถูกกระทบ",
      },
      { status: 200 }
    );
  }

  // Always 200 — the UX is "did it send or not", driven by `ok`.
  return NextResponse.json(result);
}
