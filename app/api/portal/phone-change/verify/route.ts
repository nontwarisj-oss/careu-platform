// POST /api/portal/phone-change/verify — confirm the code, commit the
// phone change. Customer is signed in throughout — the session cookie
// stays valid; only the customer's phone column changes.
//
// On success:
//   • phone_change_requests row gets verified_at stamped.
//   • customers.phone + customers.normalized_phone are updated.
//   • customer_activity row is written with kind='phone_changed'.
//   • Customer's existing portal session continues to work — the cookie
//     carries customer_id, not phone, so no re-login is required.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import { normalizePhone } from "@/lib/phone";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_ATTEMPTS = 5;

function hashCode(salt: string, code: string): string {
  return crypto
    .createHash("sha256")
    .update(`${salt}::${code}`)
    .digest("hex");
}

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "phone-change-verify",
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

  let body: { code?: string };
  try {
    body = (await req.json()) as { code?: string };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const code = (body.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json(
      { ok: false, reason: "รหัสต้องเป็นเลข 6 หลัก" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  const fetch = await admin
    .from("phone_change_requests")
    .select(
      "id, customer_id, current_phone, new_phone, code_hash, expires_at, verified_at, cancelled_at, attempts"
    )
    .eq("customer_id", session.customerId)
    .is("verified_at", null)
    .is("cancelled_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fetch.error || !fetch.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบคำขอเปลี่ยนเบอร์ — กรุณาขอใหม่" },
      { status: 404 }
    );
  }
  const row = fetch.data as {
    id: string;
    customer_id: string;
    current_phone: string;
    new_phone: string;
    code_hash: string;
    expires_at: string;
    verified_at: string | null;
    cancelled_at: string | null;
    attempts: number;
  };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await admin
      .from("phone_change_requests")
      .update({ cancelled_at: new Date().toISOString() })
      .eq("id", row.id);
    return NextResponse.json(
      { ok: false, reason: "รหัสหมดอายุ — กรุณาขอใหม่" },
      { status: 410 }
    );
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await admin
      .from("phone_change_requests")
      .update({ cancelled_at: new Date().toISOString() })
      .eq("id", row.id);
    return NextResponse.json(
      { ok: false, reason: "ใส่รหัสผิดเกินกำหนด — กรุณาขอใหม่" },
      { status: 429 }
    );
  }

  const expectedHash = hashCode(row.id, code);
  const isDev = process.env.NODE_ENV !== "production";
  const acceptDev = isDev && code === "123456";
  if (!acceptDev && expectedHash !== row.code_hash) {
    const nextAttempts = row.attempts + 1;
    await admin
      .from("phone_change_requests")
      .update({ attempts: nextAttempts })
      .eq("id", row.id);
    return NextResponse.json(
      {
        ok: false,
        reason: "รหัสไม่ถูกต้อง",
        attemptsLeft: Math.max(0, MAX_ATTEMPTS - nextAttempts),
      },
      { status: 400 }
    );
  }

  // Re-check the conflict at commit time — a different customer might
  // have grabbed the phone between request and verify.
  const conflict = await admin
    .from("customers")
    .select("id")
    .eq("normalized_phone", row.new_phone)
    .neq("id", row.customer_id)
    .limit(1)
    .maybeSingle();
  if (conflict.data) {
    await admin
      .from("phone_change_requests")
      .update({ cancelled_at: new Date().toISOString() })
      .eq("id", row.id);
    return NextResponse.json(
      {
        ok: false,
        reason:
          "เบอร์นี้ถูกใช้โดยลูกค้าอื่นในระหว่างที่คุณยืนยัน — ติดต่อสาขา",
      },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();
  // Commit: update customers + stamp the request as verified.
  const upd = await admin
    .from("customers")
    .update({
      phone: row.new_phone,
      normalized_phone: row.new_phone,
    })
    .eq("id", row.customer_id);
  if (upd.error) {
    return NextResponse.json(
      { ok: false, reason: upd.error.message },
      { status: 500 }
    );
  }
  await admin
    .from("phone_change_requests")
    .update({ verified_at: now, attempts: row.attempts + 1 })
    .eq("id", row.id);

  // Audit. Best-effort.
  try {
    await admin.from("customer_activity").insert({
      customer_id: row.customer_id,
      kind: "phone_changed",
      payload: {
        requestId: row.id,
        from: row.current_phone,
        to: row.new_phone,
        ip: ip === "unknown" ? null : ip,
      },
    });
  } catch (err) {
    console.warn(
      "[phone-change] activity insert failed",
      err instanceof Error ? err.message : String(err)
    );
  }

  return NextResponse.json({
    ok: true,
    newPhone: row.new_phone,
    customerId: row.customer_id,
  });
}
