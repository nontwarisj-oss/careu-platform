// GET /api/portal/activity — customer-safe slice of the customer's
// activity feed. Reads public.customer_activity (which is admin-only by
// default — we use the service-role admin client and filter to
// customer_id=session.customerId).
//
// Filter rationale (mirrors the portal timeline pattern):
//   • Customer-safe kinds whitelisted; everything else hidden.
//   • payload is passed through verbatim — the customer can see their
//     own metadata. Admin notes / internal stats are NEVER written to
//     customer_activity in the first place (admin notes live in
//     customer_notes, which the portal never touches).
//
// Also enriches with sent notifications (from customer_notifications)
// so the "we sent you X" event is visible. Otherwise the customer
// can't see what we sent them.

import { NextResponse } from "next/server";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CUSTOMER_SAFE_KINDS = new Set([
  // Signup / portal lifecycle
  "portal_signin",
  "prefs_changed",
  "phone_change_requested",
  "phone_changed",
  // Order events surfaced via customer_activity by future writers
  "order_completed",
  "payment_received",
  "quote_submitted",
  "upload_added",
  // CRM-tier transitions (customer-friendly versions only)
  "tier_upgraded",
]);

const KIND_LABEL: Record<string, string> = {
  portal_signin: "เข้าสู่ระบบพอร์ทัล",
  prefs_changed: "อัปเดตการแจ้งเตือน",
  phone_change_requested: "ขอเปลี่ยนเบอร์",
  phone_changed: "เปลี่ยนเบอร์เรียบร้อย",
  order_completed: "งานเสร็จสมบูรณ์",
  payment_received: "ชำระเงินเรียบร้อย",
  quote_submitted: "ส่งคำขอประเมินราคา",
  upload_added: "อัปโหลดรูปภาพ",
  tier_upgraded: "เลื่อนระดับสมาชิก",
  // Synthesised from customer_notifications:
  notification_sent: "ส่งข้อความถึงคุณ",
};

const NOTIFICATION_KIND_LABEL: Record<string, string> = {
  order_created: "รับงานเข้าระบบ",
  repair_started: "เริ่มซ่อมงาน",
  ready_for_pickup: "พร้อมรับงาน",
  order_completed: "งานเสร็จสมบูรณ์",
  overdue_pickup: "เตือนมารับงาน",
  payment_received: "รับชำระเงิน",
  otp: "รหัสยืนยัน",
};

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
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 100);

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const [activityRes, notificationsRes] = await Promise.all([
    admin
      .from("customer_activity")
      .select("id, kind, payload, created_at, branch_id")
      .eq("customer_id", session.customerId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit),
    admin
      .from("customer_notifications")
      .select("id, channel, kind, status, sent_at, created_at, payload")
      .eq("customer_id", session.customerId)
      .in("status", ["sent", "queued", "sending"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);

  const activityRows = activityRes.error || !activityRes.data
    ? []
    : (activityRes.data as Array<{
        id: string;
        kind: string;
        payload: Record<string, unknown>;
        created_at: string;
        branch_id: string | null;
      }>);

  const notifRows = notificationsRes.error || !notificationsRes.data
    ? []
    : (notificationsRes.data as Array<{
        id: string;
        channel: string;
        kind: string;
        status: string;
        sent_at: string | null;
        created_at: string;
        payload: Record<string, unknown>;
      }>);

  const activityEvents = activityRows
    .filter((r) => CUSTOMER_SAFE_KINDS.has(r.kind))
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      label: KIND_LABEL[r.kind] ?? r.kind,
      timestamp: r.created_at,
      source: "activity" as const,
      detail: summariseActivityPayload(r.kind, r.payload),
    }));

  const notificationEvents = notifRows.map((r) => ({
    id: `notif-${r.id}`,
    kind: "notification_sent",
    label: KIND_LABEL.notification_sent,
    timestamp: r.sent_at ?? r.created_at,
    source: "notification" as const,
    detail: `${(r.channel ?? "").toUpperCase()} · ${
      NOTIFICATION_KIND_LABEL[r.kind] ?? r.kind
    }${r.status !== "sent" ? ` (${r.status})` : ""}`,
  }));

  const events = [...activityEvents, ...notificationEvents]
    .sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )
    .slice(0, limit);

  return NextResponse.json({ ok: true, events });
}

function summariseActivityPayload(
  kind: string,
  payload: Record<string, unknown>
): string | null {
  if (!payload || typeof payload !== "object") return null;
  if (kind === "prefs_changed") {
    const changes = (payload as { changes?: Array<{ label?: string; to?: boolean }> })
      .changes;
    if (Array.isArray(changes) && changes.length > 0) {
      return changes
        .map((c) => `${c.label ?? ""}: ${c.to ? "เปิด" : "ปิด"}`)
        .filter((s) => s.trim().length > 2)
        .join(" · ");
    }
    return null;
  }
  if (kind === "phone_changed" || kind === "phone_change_requested") {
    const to = (payload as { to?: string }).to;
    if (typeof to === "string") return `เบอร์ใหม่ลงท้าย ...${to.slice(-4)}`;
    return null;
  }
  if (kind === "tier_upgraded") {
    const tier = (payload as { tier?: string }).tier;
    if (typeof tier === "string") return `สู่ระดับ ${tier.toUpperCase()}`;
    return null;
  }
  return null;
}
