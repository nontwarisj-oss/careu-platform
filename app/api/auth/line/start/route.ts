// Kicks off LINE OAuth. Sets a short-lived state cookie (CSRF guard) and
// 302-redirects to LINE's authorize endpoint. Until the channel is configured
// the route reports the missing env vars instead of redirecting blind.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  buildAuthorizeUrl,
  generateState,
  isLineLoginConfigured,
} from "@/lib/lineLogin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_COOKIE = "careu_line_state";
const STATE_TTL_SECONDS = 10 * 60;

export async function GET() {
  if (!isLineLoginConfigured()) {
    const missing = [
      ["LINE_LOGIN_CHANNEL_ID", process.env.LINE_LOGIN_CHANNEL_ID],
      ["LINE_LOGIN_CHANNEL_SECRET", process.env.LINE_LOGIN_CHANNEL_SECRET],
      ["LINE_LOGIN_CALLBACK_URL", process.env.LINE_LOGIN_CALLBACK_URL],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    return NextResponse.json(
      {
        ok: false,
        reason: `LINE Login ยังไม่ตั้งค่า — ตัวแปรที่ขาด: ${missing.join(", ")}`,
        missing,
      },
      { status: 503 }
    );
  }

  const state = generateState();
  const url = buildAuthorizeUrl(state);
  if (!url) {
    return NextResponse.json({ ok: false, reason: "buildAuthorizeUrl failed" }, { status: 500 });
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: STATE_COOKIE,
    value: state,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
  return NextResponse.redirect(url);
}
