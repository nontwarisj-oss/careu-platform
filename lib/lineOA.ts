// Browser-side LINE OA client wrappers. Forward to the server route at
// /api/line/send so LINE_CHANNEL_ACCESS_TOKEN never leaves the server.
// Never use NEXT_PUBLIC_LINE_* — secrets stay server-side.
//
// Two surface shapes:
//   • sendLineMessage(kind, orderId)  — typed kind, no payload override.
//     Use this for every new call site. The server builds the message via
//     lib/lineMessageBuilders and respects per-branch config + customer
//     prefs + RLS.
//   • sendToLineOA(orderId, message)  — legacy free-form text. Kept for
//     the existing "Send LINE OA" button on /orders/[id]/document until
//     the page migrates to the typed variant.

export type LineMessageKind =
  | "order_received"
  | "order_ready"
  | "pickup_reminder"
  | "receipt";

export type LineSendResult = {
  ok: boolean;
  status?: "sent" | "skipped" | "failed";
  kind?: LineMessageKind;
  reason?: string;
  lineUserId?: string;
  logId?: string | null;
  requestId?: string | null;
};

/**
 * Typed sender. Triggers the orchestrator's build-and-send for a known
 * message kind. Auth-gated server-side — the route requires one of
 * owner / hq_admin / branch_manager / front_staff.
 */
export async function sendLineMessage(
  kind: LineMessageKind,
  orderId: string
): Promise<LineSendResult> {
  if (typeof window === "undefined") {
    return {
      ok: false,
      reason: "sendLineMessage must be called from the browser",
    };
  }
  if (!orderId) return { ok: false, reason: "Missing order id" };

  try {
    const res = await fetch("/api/line/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, kind }),
    });
    const json = (await res.json()) as LineSendResult;
    return json;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Network error",
    };
  }
}

// ---------- Legacy wrapper (kept for /orders/[id]/document) --------------

export type LineOAResult = {
  ok: boolean;
  reason?: string;
};

/**
 * Backwards-compatible wrapper. The server route now interprets a
 * payload with `message` (but no `kind`) as a receipt-style send.
 * Prefer `sendLineMessage('receipt', orderId)` for new code.
 */
export async function sendToLineOA(
  orderId: string,
  message: string,
  to?: string
): Promise<LineOAResult> {
  if (!orderId) return { ok: false, reason: "Missing order id" };
  if (typeof window === "undefined") {
    return {
      ok: false,
      reason: "sendToLineOA must be called from the browser",
    };
  }
  try {
    const res = await fetch("/api/line/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, message, to }),
    });
    const json = (await res.json()) as LineOAResult;
    return { ok: Boolean(json.ok), reason: json.reason };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Network error",
    };
  }
}
