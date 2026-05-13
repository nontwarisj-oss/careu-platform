import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SendBody = {
  orderId?: string;
  message?: string;
  /**
   * Customer's LINE user id (returned by the LINE follow webhook).
   * Until the follow flow is wired we cannot push individual messages,
   * so this route returns a friendly "not yet implemented" response.
   */
  to?: string;
};

/**
 * POST /api/line/send
 *
 * Server-only route placeholder for pushing the intake/quote/receipt
 * document message to a customer via LINE Messaging API. Secrets are read
 * from process.env at runtime and NEVER exposed to the client.
 *
 * Required env vars (Vercel project / .env.local — see .env.example):
 *   LINE_CHANNEL_ACCESS_TOKEN
 *   LINE_CHANNEL_SECRET (used for webhook signature verification, not push)
 *   LINE_OA_ID          (deep-link helper)
 *
 * Once LINE follow flow is in place and a customer LINE user id is stored,
 * uncomment the real push block below. Until then the route stays inert so
 * we never accidentally hit LINE in production without proper recipient
 * tracking.
 */
export async function POST(req: Request) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "LINE OA ยังไม่ตั้งค่า — เพิ่ม LINE_CHANNEL_ACCESS_TOKEN ใน environment ของ Vercel ก่อน",
      },
      { status: 503 }
    );
  }

  let body: SendBody;
  try {
    body = (await req.json()) as SendBody;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { orderId, message, to } = body;
  if (!orderId || !message) {
    return NextResponse.json(
      { ok: false, reason: "Missing orderId or message" },
      { status: 400 }
    );
  }

  if (!to) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "ยังไม่มี LINE user id ของลูกค้าในระบบ — ต้องเปิด LINE Follow flow ก่อนถึงจะส่งได้",
      },
      { status: 501 }
    );
  }

  // Real LINE push — left commented until the follow flow is wired so we
  // don't accidentally invoke the API. When enabling, also rate-limit and
  // record the push id back on the order row for audit.
  //
  // const res = await fetch("https://api.line.me/v2/bot/message/push", {
  //   method: "POST",
  //   headers: {
  //     Authorization: `Bearer ${token}`,
  //     "Content-Type": "application/json",
  //   },
  //   body: JSON.stringify({
  //     to,
  //     messages: [{ type: "text", text: message }],
  //   }),
  // });
  // if (!res.ok) {
  //   const text = await res.text();
  //   return NextResponse.json(
  //     { ok: false, reason: `LINE API ${res.status}: ${text}` },
  //     { status: 502 }
  //   );
  // }
  // return NextResponse.json({ ok: true });

  return NextResponse.json(
    {
      ok: false,
      reason:
        "Server route พร้อมใช้งานแล้ว แต่ฟังก์ชันส่งจริงรอเปิดใช้งานในเฟสถัดไป",
    },
    { status: 501 }
  );
}
