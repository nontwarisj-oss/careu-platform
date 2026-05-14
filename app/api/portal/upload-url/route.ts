// POST /api/portal/upload-url — issue a signed upload URL for a
// signed-in customer. Always scopes the resulting path to the
// customer's own branch + customer_id; the caller cannot pick a path.

import { NextResponse } from "next/server";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { issueUploadUrl } from "@/lib/uploadService";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  mime?: string;
  size?: number;
  /** Optional — the scope the customer is uploading for. Defaults to
   *  'customer' so the path lands under their own folder. */
  scope?: "customer" | "order";
  orderId?: string;
};

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "portal-upload-url",
    limit: 30,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "Too many requests" },
      { status: 429 }
    );
  }
  const session = await readCustomerSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, reason: "ยังไม่ได้เข้าสู่ระบบ" },
      { status: 401 }
    );
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }
  const mime = body.mime ?? "";
  const declaredSize =
    typeof body.size === "number" && Number.isFinite(body.size)
      ? body.size
      : null;
  const wantScope = body.scope ?? "customer";

  // Resolve branch slug. Customers may not have a branch_id set if they
  // signed up via portal-only flow — fall back to the "self-portal"
  // pseudo-branch so uploads still land somewhere predictable.
  const admin = getSupabaseAdmin();
  let branchCode: string = "self-portal";
  if (admin) {
    const row = await admin
      .from("customers")
      .select("branch_id")
      .eq("id", session.customerId)
      .maybeSingle();
    const b = (row.data as { branch_id: string | null } | null)?.branch_id;
    if (b) branchCode = b;
  }

  if (wantScope === "order") {
    const orderId = body.orderId?.trim();
    if (!orderId || !admin) {
      return NextResponse.json(
        { ok: false, reason: "Missing orderId" },
        { status: 400 }
      );
    }
    // Hard-check: order must belong to the signed-in customer.
    const orderRes = await admin
      .from("orders")
      .select("customer_id, branch_id")
      .eq("id", orderId)
      .maybeSingle();
    const order = orderRes.data as
      | { customer_id: string | null; branch_id: string | null }
      | null;
    if (!order || order.customer_id !== session.customerId) {
      return NextResponse.json(
        { ok: false, reason: "ไม่พบงาน" },
        { status: 404 }
      );
    }
    const result = await issueUploadUrl({
      scope: {
        scope: "order",
        branchCode: order.branch_id ?? branchCode,
        orderId,
      },
      mime,
      declaredSize,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  }

  // Default — upload to the customer's own folder.
  const result = await issueUploadUrl({
    scope: {
      scope: "customer",
      branchCode,
      customerId: session.customerId,
    },
    mime,
    declaredSize,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
