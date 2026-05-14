// GET /api/track/open?t=<token>
//
// 1×1 transparent GIF returned regardless of token validity (so the
// email client doesn't show a broken image). Side effects only on
// signature-valid tokens.

import { NextResponse } from "next/server";
import { verifyTrackingToken } from "@/lib/trackingLinks";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { recordCommunicationEvent } from "@/lib/communicationEvents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 1×1 transparent GIF, base64-encoded.
const PIXEL_BASE64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function pixelResponse(): NextResponse {
  const body = Buffer.from(PIXEL_BASE64, "base64");
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(body.length),
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  if (!token) return pixelResponse();

  const v = verifyTrackingToken(token);
  if (!v.ok) return pixelResponse();
  if (v.payload.kind !== "open") return pixelResponse();

  const admin = getSupabaseAdmin();
  let customerId: string | null = null;
  let branchId: string | null = null;
  let channel: "sms" | "line" | "email" = "email";
  if (admin) {
    const r = await admin
      .from("customer_notifications")
      .select("customer_id, branch_id, channel")
      .eq("id", v.payload.nid)
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
    notificationId: v.payload.nid,
    customerId,
    branchId,
    channel,
    eventType: "opened",
    provider: "tracking",
    providerEventId: token.slice(0, 64),
    userAgent: req.headers.get("user-agent"),
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  return pixelResponse();
}
