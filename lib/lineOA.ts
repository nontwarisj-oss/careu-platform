// LINE Official Account integration is intentionally a placeholder right now.
// The real Messaging API call must run on the server (route handler or edge
// function) because it requires LINE_CHANNEL_ACCESS_TOKEN, which is a secret.
//
// Required env vars (set in Vercel / .env.local, never committed):
//   LINE_CHANNEL_ACCESS_TOKEN  — long-lived channel access token
//   LINE_CHANNEL_SECRET        — channel secret (webhook signature verify)
//   LINE_OA_ID                 — friend ID / Basic ID of the OA, used for deep links
//
// When credentials are provisioned, replace the body of sendToLineOA with a
// POST to /api/line/send (a new route handler that reads the secrets at runtime
// and calls https://api.line.me/v2/bot/message/push). Do NOT inline secrets in
// client code, and never expose them via NEXT_PUBLIC_*.

export type LineOAResult = {
  ok: boolean;
  reason?: string;
};

/**
 * Stub for sending a document/message to a customer via LINE OA.
 * Returns ok=false with a friendly reason until the real integration is wired.
 */
export async function sendToLineOA(
  orderId: string,
  _message: string
): Promise<LineOAResult> {
  if (!orderId) {
    return { ok: false, reason: "Missing order id" };
  }
  return {
    ok: false,
    reason:
      "ยังไม่ได้ตั้งค่า LINE OA ในระบบ — โปรดเพิ่ม LINE_CHANNEL_ACCESS_TOKEN และต่อ API endpoint ก่อนใช้งานจริง",
  };
}
