// GET /api/track/click?t=<token>
//
// Public endpoint — no auth. The token's HMAC signature is the
// authorization. On success:
//   1. Record a 'clicked' event in communication_events.
//   2. 302-redirect to the original target URL.
//   3. Bad / expired tokens redirect to NEXT_PUBLIC_BASE_URL with no
//      side effects. They DO write a log row with provider='tracking'
//      so the operator can see probe traffic if any.
//
// Replay safety: provider_event_id=token-signature so the same click
// recorded twice from the same email opens a duplicate-row insert
// which the unique index drops.

import { NextResponse } from "next/server";
import { verifyTrackingToken } from "@/lib/trackingLinks";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { recordCommunicationEvent } from "@/lib/communicationEvents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FALLBACK_REDIRECT = process.env.NEXT_PUBLIC_BASE_URL ?? "/";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  if (!token) return NextResponse.redirect(FALLBACK_REDIRECT);

  const v = verifyTrackingToken(token);
  if (!v.ok) {
    // Don't record probe traffic as a click — but DO record it as a
    // forensic note so the operator sees the volume.
    await recordCommunicationEvent({
      channel: "email",
      eventType: "clicked",
      provider: "tracking",
      providerEventId: token.slice(0, 64),
      details: { reason: v.reason, valid: false },
    });
    return NextResponse.redirect(FALLBACK_REDIRECT);
  }
  const { payload } = v;
  if (payload.kind !== "click") {
    return NextResponse.redirect(FALLBACK_REDIRECT);
  }

  // Load the notification's customer + branch so the recorded event
  // is searchable.
  const admin = getSupabaseAdmin();
  let customerId: string | null = null;
  let branchId: string | null = null;
  let channel: "sms" | "line" | "email" = "email";
  if (admin) {
    const r = await admin
      .from("customer_notifications")
      .select("customer_id, branch_id, channel")
      .eq("id", payload.nid)
      .maybeSingle();
    const row = r.data as
      | { customer_id: string | null; branch_id: string | null; channel: string }
      | null;
    if (row) {
      customerId = row.customer_id;
      branchId = row.branch_id;
      if (row.channel === "sms" || row.channel === "line" || row.channel === "email") {
        channel = row.channel;
      }
    }
  }

  await recordCommunicationEvent({
    notificationId: payload.nid,
    customerId,
    branchId,
    channel,
    eventType: "clicked",
    provider: "tracking",
    providerEventId: token.slice(0, 64),
    targetUrl: payload.url,
    userAgent: req.headers.get("user-agent"),
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  // Validate the target URL isn't javascript: / data: etc.
  let safeTarget: URL;
  try {
    safeTarget = new URL(payload.url);
  } catch {
    return NextResponse.redirect(FALLBACK_REDIRECT);
  }
  if (!/^https?:$/.test(safeTarget.protocol)) {
    return NextResponse.redirect(FALLBACK_REDIRECT);
  }

  return NextResponse.redirect(safeTarget.toString(), 302);
}
