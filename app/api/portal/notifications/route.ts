// GET  /api/portal/notifications — the signed-in customer's
//        notification centre feed.
// POST /api/portal/notifications — mark one / all read.
//
// Phase 27A. Reads customer_notifications scoped to the session
// customer_id. read/unread state lives in customer_read_at (NULL =
// unread). Optional ?channel= filter (sms | line | email | in_app).

import { NextResponse } from "next/server";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Customer-facing Thai labels for the internal `kind` event ids.
const KIND_LABEL: Record<string, string> = {
  order_ready: "งานของคุณพร้อมรับแล้ว",
  order_received: "รับงานเข้าระบบแล้ว",
  pickup_reminder: "เตือนรับงาน",
  payment_reminder: "เตือนชำระเงิน",
  welcome: "ยินดีต้อนรับ",
  reactivation: "เรายินดีให้บริการอีกครั้ง",
  broadcast: "ข่าวสารและโปรโมชัน",
  retention: "ข้อเสนอพิเศษสำหรับคุณ",
  birthday: "สุขสันต์วันเกิด",
};

const STATUS_LABEL: Record<string, string> = {
  queued: "รอส่ง",
  sending: "กำลังส่ง",
  sent: "ส่งแล้ว",
  delivered: "ส่งถึงแล้ว",
  failed: "ส่งไม่สำเร็จ",
  skipped: "ข้าม",
  dead_letter: "ส่งไม่สำเร็จ",
};

function snippet(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const candidate =
    (typeof payload.body === "string" && payload.body) ||
    (typeof payload.message === "string" && payload.message) ||
    (typeof payload.text === "string" && payload.text) ||
    null;
  if (!candidate) return null;
  return candidate.length > 160 ? `${candidate.slice(0, 157)}…` : candidate;
}

export async function GET(req: Request) {
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

  const url = new URL(req.url);
  const channel = (url.searchParams.get("channel") ?? "").trim();

  let q = admin
    .from("customer_notifications")
    .select(
      "id, channel, kind, status, payload, created_at, sent_at, customer_read_at"
    )
    .eq("customer_id", session.customerId)
    .order("created_at", { ascending: false })
    .limit(80);
  if (channel) q = q.eq("channel", channel);

  const { data, error } = await q;
  if (error) {
    return NextResponse.json(
      { ok: false, reason: error.message },
      { status: 500 }
    );
  }
  const rows = (data ?? []) as Array<{
    id: string;
    channel: string;
    kind: string;
    status: string;
    payload: Record<string, unknown> | null;
    created_at: string;
    sent_at: string | null;
    customer_read_at: string | null;
  }>;

  const notifications = rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    kind: r.kind,
    title: KIND_LABEL[r.kind] ?? "การแจ้งเตือน",
    body: snippet(r.payload),
    status: r.status,
    statusLabel: STATUS_LABEL[r.status] ?? r.status,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    read: r.customer_read_at != null,
  }));

  // Unread count is computed over the unfiltered feed.
  let unreadCount = notifications.filter((n) => !n.read).length;
  if (channel) {
    const total = await admin
      .from("customer_notifications")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", session.customerId)
      .is("customer_read_at", null);
    unreadCount = total.count ?? unreadCount;
  }

  return NextResponse.json({ ok: true, notifications, unreadCount });
}

export async function POST(req: Request) {
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

  let body: { action?: string; id?: string };
  try {
    body = (await req.json()) as { action?: string; id?: string };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  if (body.action !== "mark-read") {
    return NextResponse.json(
      { ok: false, reason: "action='mark-read' required" },
      { status: 400 }
    );
  }

  const nowIso = new Date().toISOString();
  let upd = admin
    .from("customer_notifications")
    .update({ customer_read_at: nowIso })
    .eq("customer_id", session.customerId)
    .is("customer_read_at", null);
  // A specific id marks one row; otherwise mark every unread row.
  if (body.id) upd = upd.eq("id", body.id);

  const res = await upd.select("id");
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({
    ok: true,
    markedRead: (res.data ?? []).length,
  });
}
