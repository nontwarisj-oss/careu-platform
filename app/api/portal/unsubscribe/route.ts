// GET  /api/portal/unsubscribe              — list customer's branch unsubscribes.
// POST /api/portal/unsubscribe              — add an unsubscribe.
// DELETE /api/portal/unsubscribe?id=...     — remove (re-subscribe).
//
// The portal lets customers opt out from a SPECIFIC branch without
// disabling the channel globally. Layered on top of the Phase 13
// global preferences. The communication policy service consults both.

import { NextResponse } from "next/server";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID_CHANNELS = new Set(["sms", "line", "email", "all"]);
const VALID_SCOPES = new Set(["marketing", "all"]);

export async function GET() {
  const session = await readCustomerSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, reason: "ยังไม่ได้เข้าสู่ระบบ" },
      { status: 401 }
    );
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  const res = await admin
    .from("customer_branch_unsubscribes")
    .select(
      "id, branch_id, channel, scope, reason, unsubscribed_at, source"
    )
    .eq("customer_id", session.customerId)
    .order("unsubscribed_at", { ascending: false });
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, rows: res.data ?? [] });
}

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "portal-unsubscribe",
    limit: 20,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "ลองมากเกินไป" },
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
  let body: { branchId?: string; channel?: string; scope?: string; reason?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const branchId = (body.branchId ?? "").trim();
  const channel = (body.channel ?? "").trim();
  const scope = (body.scope ?? "marketing").trim();
  if (!branchId || !VALID_CHANNELS.has(channel) || !VALID_SCOPES.has(scope)) {
    return NextResponse.json(
      {
        ok: false,
        reason: "branchId + channel(sms/line/email/all) + scope(marketing/all) required",
      },
      { status: 400 }
    );
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  // Upsert via the unique index. Capture provenance.
  const ins = await admin
    .from("customer_branch_unsubscribes")
    .upsert(
      {
        customer_id: session.customerId,
        branch_id: branchId,
        channel,
        scope,
        reason: (body.reason ?? "").trim() || null,
        source: "self",
        unsubscribed_by: session.customerId,
      },
      { onConflict: "customer_id,branch_id,channel,scope" }
    )
    .select("id")
    .single();
  if (ins.error || !ins.data) {
    return NextResponse.json(
      { ok: false, reason: ins.error?.message ?? "Insert failed" },
      { status: 500 }
    );
  }
  return NextResponse.json({
    ok: true,
    id: (ins.data as { id: string }).id,
  });
}

export async function DELETE(req: Request) {
  const session = await readCustomerSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, reason: "ยังไม่ได้เข้าสู่ระบบ" },
      { status: 401 }
    );
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { ok: false, reason: "id query param required" },
      { status: 400 }
    );
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  // Hard delete — operator can re-subscribe by removing the row.
  // Branch-scoped so customer can't delete somebody else's row.
  const del = await admin
    .from("customer_branch_unsubscribes")
    .delete()
    .eq("id", id)
    .eq("customer_id", session.customerId);
  if (del.error) {
    return NextResponse.json(
      { ok: false, reason: del.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
