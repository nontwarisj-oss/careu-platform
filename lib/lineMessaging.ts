// Low-level LINE Messaging API client. Server-only — every call uses the
// channel access token resolved by lib/lineConfig.ts.
//
// API reference: https://developers.line.biz/en/reference/messaging-api/
//
// Scope discipline:
//   • push only (one-to-one). Multicast / broadcast are future phases.
//   • text messages only in the MVP; Flex Message helpers come with the
//     receipt-image phase.
//   • this module does NOT log to public.line_message_log — that's the
//     orchestrator's job. Keeping logging out of here means a future
//     retry job can call pushTextMessage directly without double-logging.

import type { LineChannelConfig } from "@/lib/lineConfig";

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

export type LineMessage =
  | { type: "text"; text: string }
  | { type: "flex"; altText: string; contents: Record<string, unknown> };

export type PushResult =
  | { ok: true; requestId: string | null }
  | { ok: false; status: number; reason: string };

/** Push up to 5 messages to one LINE user. */
export async function pushMessages(
  config: LineChannelConfig,
  toLineUserId: string,
  messages: LineMessage[]
): Promise<PushResult> {
  if (!toLineUserId) {
    return { ok: false, status: 0, reason: "missing toLineUserId" };
  }
  if (messages.length === 0) {
    return { ok: false, status: 0, reason: "no messages to send" };
  }
  if (messages.length > 5) {
    return {
      ok: false,
      status: 0,
      reason: "LINE push supports at most 5 messages per request",
    };
  }

  let res: Response;
  try {
    res = await fetch(LINE_PUSH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.channelAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to: toLineUserId, messages }),
      cache: "no-store",
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: err instanceof Error ? err.message : "network error",
    };
  }

  if (!res.ok) {
    const body = await safeReadBody(res);
    return { ok: false, status: res.status, reason: body };
  }

  // The push endpoint returns 200 with an empty body and an
  // x-line-request-id header (handy for support tickets).
  const requestId = res.headers.get("x-line-request-id");
  return { ok: true, requestId };
}

/** Convenience helper: push one text message. */
export async function pushTextMessage(
  config: LineChannelConfig,
  toLineUserId: string,
  text: string
): Promise<PushResult> {
  return pushMessages(config, toLineUserId, [{ type: "text", text }]);
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}
