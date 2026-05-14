// POST /api/portal/auth/request-otp — issue a one-time code for portal sign-in.
//
// Foundation phase: codes are emitted via console.info (no SMS gateway).
// In non-production, the universal dev code "123456" is also accepted by
// the verify route. Rate-limited per IP to make casual enumeration
// expensive.

import { NextResponse } from "next/server";
import { issueCustomerOtp } from "@/lib/customerOtp";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "portal-otp-issue",
    limit: 5,
    windowMs: 10 * 60 * 1000, // 5 per 10 minutes
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "Too many requests" },
      { status: 429 }
    );
  }
  let body: { phone?: string };
  try {
    body = (await req.json()) as { phone?: string };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const result = await issueCustomerOtp(body.phone ?? "", {
    ip: ip === "unknown" ? null : ip,
    ua: req.headers.get("user-agent")?.slice(0, 200) ?? null,
  });
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    requestId: result.requestId,
    expiresAt: result.expiresAt,
    // Non-prod only — surfaces in the UI for QA flows.
    devCode: result.devCode,
  });
}
