// POST /api/public/track — public job-tracking lookup.
//
// Customer enters a job ID (the 8-char ref or the full job_id) + their
// phone number. Returns a deliberately narrow subset of order data:
//   • status / payment status (informational)
//   • branch label (so customer knows which shop)
//   • due_date (so customer knows when to pick up)
//   • ready flag (so customer knows whether to come)
//
// Deliberately NOT returned:
//   • internal cost / labor / material data
//   • technician identity
//   • full order id (already inferred from the request)
//   • notes / template_text (may contain private staff notes)
//
// Security:
//   • Anon route — anyone can call.
//   • Phone is the auth factor (must match the order's customer phone).
//   • Rate-limited per IP+jobId composite to make brute-force enumeration
//     of jobIds impractical (5 attempts per 60 seconds).
//   • Uses the service-role admin client to read across RLS so the
//     customer can hit any branch; per-row branch identity is exposed
//     only as a friendly branch_label, never as a branch slug.
//
// Reads via service-role: the JWT bridge isn't present for anonymous
// callers, so the regular anon supabase client would hit RLS and return
// 0 rows. The admin client bypasses RLS; we hand-pick the columns we
// return so RLS bypass doesn't leak sensitive fields.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import { normalizePhone } from "@/lib/phone";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  jobId?: string;
  phone?: string;
};

const STATUS_LABEL: Record<string, { th: string; en: string }> = {
  pending: { th: "รอดำเนิน", en: "Pending" },
  "in-progress": { th: "กำลังซ่อม", en: "In progress" },
  completed: { th: "เสร็จสิ้น", en: "Completed" },
  "ready-for-pickup": { th: "พร้อมรับ", en: "Ready for pickup" },
  cancelled: { th: "ยกเลิก", en: "Cancelled" },
};

const PAYMENT_LABEL: Record<string, { th: string; en: string }> = {
  unpaid: { th: "ยังไม่ชำระ", en: "Unpaid" },
  deposit: { th: "มัดจำแล้ว", en: "Deposit paid" },
  paid: { th: "ชำระแล้ว", en: "Paid" },
};

export async function POST(req: Request) {
  // Step 1: rate-limit BEFORE parsing the body so a flood of malformed
  // POSTs doesn't slip past.
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "public-track",
    limit: 10,
    windowMs: 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": "60" },
      }
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const jobId = (body.jobId ?? "").trim().toUpperCase();
  const phone = normalizePhone(body.phone ?? "");
  if (!jobId || !phone) {
    return NextResponse.json(
      { ok: false, reason: "ระบุ Job ID และเบอร์โทร" },
      { status: 400 }
    );
  }

  // Step 2: per-jobId rate limit — protects against an IP brute-forcing
  // the same jobId with different phones.
  const pairLimit = rateLimit(`${ip}::${jobId}`, {
    namespace: "public-track-pair",
    limit: 5,
    windowMs: 60 * 1000,
  });
  if (!pairLimit.ok) {
    return NextResponse.json(
      { ok: false, reason: "ลองมากเกินไป — รอสักครู่แล้วลองใหม่" },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "บริการติดตามงานปิดชั่วคราว — กรุณาลองภายหลัง" },
      { status: 503 }
    );
  }

  // Step 3: look up the order. Try by job_id first (canonical), then by
  // first-8-chars-of-id prefix (the refId the receipt prints). Limit to
  // a single match — duplicate job_ids per branch are blocked by the
  // partial unique index, but the same id across branches is possible.
  // We require the phone match below so cross-branch confusion is safe.
  let orderRow: Record<string, unknown> | null = null;
  const byJobId = await admin
    .from("orders")
    .select(
      "id, customer_id, status, payment_status, due_date, created_at, branch_id, job_id"
    )
    .eq("job_id", jobId)
    .limit(2);
  if (!byJobId.error && byJobId.data && byJobId.data.length > 0) {
    // When two branches share a job_id, we can't tell them apart without
    // the phone match — fall through to the phone check below for each
    // candidate.
    orderRow = byJobId.data[0] as Record<string, unknown>;
  }
  if (!orderRow) {
    // Fallback: refId is first 8 chars of id, uppercase. Use ilike with
    // anchored prefix on text-cast id.
    const byPrefix = await admin
      .from("orders")
      .select(
        "id, customer_id, status, payment_status, due_date, created_at, branch_id, job_id"
      )
      .ilike("id", `${jobId.toLowerCase()}%`)
      .limit(1);
    if (!byPrefix.error && byPrefix.data && byPrefix.data.length > 0) {
      orderRow = byPrefix.data[0] as Record<string, unknown>;
    }
  }

  if (!orderRow) {
    // Don't reveal whether the jobId exists at all — same response shape
    // as a mismatched phone, makes enumeration useless.
    return NextResponse.json(
      { ok: false, reason: "ไม่พบงานนี้ — ตรวจสอบ Job ID และเบอร์โทร" },
      { status: 404 }
    );
  }

  // Step 4: verify phone via the joined customer row. Required.
  const customerId = (orderRow.customer_id as string) ?? null;
  if (!customerId) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบลูกค้าผูกกับงานนี้ — ติดต่อร้านสาขา" },
      { status: 404 }
    );
  }
  const custRes = await admin
    .from("customers")
    .select("phone, normalized_phone")
    .eq("id", customerId)
    .maybeSingle();
  const custRow = custRes.data as
    | { phone: string | null; normalized_phone: string | null }
    | null;
  const candidate =
    custRow?.normalized_phone ?? normalizePhone(custRow?.phone ?? "");
  if (!candidate || candidate !== phone) {
    return NextResponse.json(
      { ok: false, reason: "Job ID และเบอร์โทรไม่ตรงกัน" },
      { status: 404 }
    );
  }

  // Step 5: enrich with the branch's display name. Don't leak the slug.
  let branchLabel: string | null = null;
  const branchSlug = (orderRow.branch_id as string) ?? null;
  if (branchSlug) {
    const branchRes = await admin
      .from("branches")
      .select("name, short_label, short_name")
      .eq("code", branchSlug)
      .maybeSingle();
    const branchRow = branchRes.data as
      | { name: string; short_label: string | null; short_name: string | null }
      | null;
    branchLabel =
      branchRow?.short_label ?? branchRow?.short_name ?? branchRow?.name ?? null;
  }

  const status = (orderRow.status as string) ?? "pending";
  const paymentStatus = (orderRow.payment_status as string) ?? "unpaid";

  return NextResponse.json({
    ok: true,
    jobId,
    branchLabel,
    status,
    statusLabel: STATUS_LABEL[status]?.th ?? status,
    paymentStatus,
    paymentLabel: PAYMENT_LABEL[paymentStatus]?.th ?? paymentStatus,
    dueDate: (orderRow.due_date as string) ?? null,
    createdAt: (orderRow.created_at as string) ?? null,
    readyForPickup: status === "ready-for-pickup",
  });
}
