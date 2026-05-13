// Client-side wrapper around /api/line/send.
//
// The real LINE Messaging API call lives in the server route handler at
// app/api/line/send/route.ts so that LINE_CHANNEL_ACCESS_TOKEN never leaves
// the server. Never use NEXT_PUBLIC_LINE_* — secrets must stay server-side.
//
// Required env vars (set in Vercel / .env.local, see .env.example):
//   LINE_CHANNEL_ACCESS_TOKEN  — long-lived channel access token
//   LINE_CHANNEL_SECRET        — channel secret (webhook signature verify)
//   LINE_OA_ID                 — friend / Basic ID for deep links

export type LineOAResult = {
  ok: boolean;
  reason?: string;
};

/**
 * Forwards an outbound message request to the server route. The route is
 * inert until LINE_CHANNEL_ACCESS_TOKEN is present AND we have the
 * customer's LINE user id captured via the follow flow.
 */
export async function sendToLineOA(
  orderId: string,
  message: string,
  to?: string
): Promise<LineOAResult> {
  if (!orderId) {
    return { ok: false, reason: "Missing order id" };
  }
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
