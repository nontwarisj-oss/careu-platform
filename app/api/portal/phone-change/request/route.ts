// POST /api/portal/phone-change/request — start a phone-change flow.
//
// Customer (signed-in) provides the NEW phone. We:
//   1. Verify the customer doesn't already own the new phone.
//   2. Verify no other customers currently use the new phone (anti-
//      takeover: phone conflict surfaces back to the customer).
//   3. Verify there isn't another pending request for the same new
//      phone in flight (unique partial index on the table enforces
//      this at the DB level; we surface it as a friendly 409).
//   4. Generate a 6-digit code, hash it (sha256 with the row id as
//      salt), and persist a phone_change_requests row.
//   5. Send the code to the new phone via the configured SMS provider.
//
// Audit: a customer_activity row with kind='phone_change_requested'
// is written so admins can trace the request later.
//
// Security limits:
//   • 3 requests / hour / customer.
//   • Code TTL 10 minutes (longer than sign-in OTP because the
//     customer is mid-task).

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import { normalizePhone } from "@/lib/phone";
import { sendSms } from "@/lib/smsProvider";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TTL_SECONDS = 10 * 60;

function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCode(salt: string, code: string): string {
  return crypto
    .createHash("sha256")
    .update(`${salt}::${code}`)
    .digest("hex");
}

export async function POST(req: Request) {
  const ip = callerIp(req);
  const ipLimit = rateLimit(ip, {
    namespace: "phone-change-request-ip",
    limit: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { ok: false, reason: ipLimit.reason ?? "ลองมากเกินไป — รอสักครู่" },
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
  // Per-customer rate-limit on top of per-IP — protects against an
  // attacker who somehow has the cookie but uses many IPs.
  const customerLimit = rateLimit(session.customerId, {
    namespace: "phone-change-request-customer",
    limit: 3,
    windowMs: 60 * 60 * 1000,
  });
  if (!customerLimit.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "ขอเปลี่ยนเบอร์ได้ไม่เกิน 3 ครั้งต่อชั่วโมง — กรุณารอสักครู่",
      },
      { status: 429 }
    );
  }

  let body: { newPhone?: string };
  try {
    body = (await req.json()) as { newPhone?: string };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const newPhone = normalizePhone(body.newPhone ?? "");
  if (!newPhone) {
    return NextResponse.json(
      { ok: false, reason: "เบอร์ใหม่ไม่ถูกต้อง" },
      { status: 400 }
    );
  }
  if (newPhone === normalizePhone(session.phone)) {
    return NextResponse.json(
      { ok: false, reason: "เบอร์ใหม่ตรงกับเบอร์ปัจจุบัน" },
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

  // Conflict check — another customer already uses this phone? Refuse;
  // a future merge tool resolves the case where the same person owns
  // two records.
  const conflict = await admin
    .from("customers")
    .select("id")
    .eq("normalized_phone", newPhone)
    .neq("id", session.customerId)
    .limit(1)
    .maybeSingle();
  if (conflict.data) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "เบอร์นี้มีลูกค้าอื่นใช้แล้ว — ติดต่อสาขาเพื่อย้าย/รวมบัญชี",
      },
      { status: 409 }
    );
  }

  // Cancel any older pending requests for this customer (one in-flight
  // at a time).
  await admin
    .from("phone_change_requests")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("customer_id", session.customerId)
    .is("verified_at", null)
    .is("cancelled_at", null);

  const code = generateCode();
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();
  const insertRes = await admin
    .from("phone_change_requests")
    .insert({
      customer_id: session.customerId,
      current_phone: normalizePhone(session.phone),
      new_phone: newPhone,
      // Temp placeholder; we re-update with the real hash after we have
      // the row id (used as the salt).
      code_hash: "pending",
      expires_at: expiresAt,
      request_meta: {
        ip: ip === "unknown" ? null : ip,
        ua: req.headers.get("user-agent")?.slice(0, 200) ?? null,
      },
    })
    .select("id")
    .single();
  if (insertRes.error || !insertRes.data) {
    const reason = insertRes.error?.message ?? "Insert failed";
    // The unique partial index catches a concurrent request — translate.
    const friendly = /duplicate key/i.test(reason)
      ? "มีคำขออื่นใช้เบอร์ใหม่นี้อยู่ — กรุณารอสักครู่แล้วลองใหม่"
      : reason;
    return NextResponse.json(
      { ok: false, reason: friendly },
      { status: 409 }
    );
  }
  const rowId = (insertRes.data as { id: string }).id;
  const codeHash = hashCode(rowId, code);
  await admin
    .from("phone_change_requests")
    .update({ code_hash: codeHash })
    .eq("id", rowId);

  void sendSms({
    to: newPhone,
    body: `Care U OPS รหัสยืนยันการเปลี่ยนเบอร์: ${code} (อายุ 10 นาที)`,
    meta: { kind: "phone-change", requestId: rowId },
  }).catch((err) => {
    console.warn(
      "[phone-change] sms send threw",
      err instanceof Error ? err.message : String(err)
    );
  });

  // Audit: customer_activity. Best-effort.
  try {
    await admin.from("customer_activity").insert({
      customer_id: session.customerId,
      kind: "phone_change_requested",
      payload: {
        requestId: rowId,
        currentPhone: normalizePhone(session.phone),
        newPhone,
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
    requestId: rowId,
    expiresAt,
    // Dev convenience — non-prod returns the code so QA flows work.
    devCode: process.env.NODE_ENV === "production" ? null : code,
  });
}
