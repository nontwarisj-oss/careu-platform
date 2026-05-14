// POST /api/portal/auth/verify-otp — verify the code, mint the customer
// session cookie, and find-or-create the customers row.
//
// On success the customer cookie is set + the customer record is
// returned (id, name, phone, tier, lifecycle).

import { NextResponse } from "next/server";
import { verifyCustomerOtp } from "@/lib/customerOtp";
import { findOrCreateByPhone } from "@/lib/customerIdentityResolver";
import {
  encodeCustomerSession,
  setCustomerSessionCookie,
} from "@/lib/customerSession";
import { refreshCustomerProgression } from "@/lib/crmProgressionService";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "portal-otp-verify",
    limit: 20,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "Too many requests" },
      { status: 429 }
    );
  }
  let body: { phone?: string; code?: string };
  try {
    body = (await req.json()) as { phone?: string; code?: string };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const verify = await verifyCustomerOtp(body.phone ?? "", body.code ?? "");
  if (!verify.ok) {
    return NextResponse.json(verify, { status: 400 });
  }

  const resolved = await findOrCreateByPhone(verify.phone);
  if (!resolved.ok) {
    return NextResponse.json(resolved, { status: 500 });
  }

  // Recompute lifecycle / retention so the new login is reflected in
  // the customer's progression. Best-effort.
  void refreshCustomerProgression(resolved.customer.id);

  const cookieValue = encodeCustomerSession({
    customerId: resolved.customer.id,
    phone: verify.phone,
    name: resolved.customer.name,
  });
  if (!cookieValue) {
    return NextResponse.json(
      {
        ok: false,
        reason: "SESSION_SECRET ยังไม่ตั้งค่า — portal session ใช้งานไม่ได้",
      },
      { status: 503 }
    );
  }
  await setCustomerSessionCookie(cookieValue);

  return NextResponse.json({
    ok: true,
    customer: {
      id: resolved.customer.id,
      name: resolved.customer.name,
      phone: resolved.customer.phone,
      tier: resolved.customer.customerTier,
      lifecycle: resolved.customer.lifecycleStage,
      branchId: resolved.customer.branchId,
    },
    created: resolved.created,
  });
}
