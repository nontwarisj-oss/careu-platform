// POST /api/portal/auth/logout — clear the customer cookie.

import { NextResponse } from "next/server";
import { clearCustomerSessionCookie } from "@/lib/customerSession";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  await clearCustomerSessionCookie();
  return NextResponse.json({ ok: true });
}
