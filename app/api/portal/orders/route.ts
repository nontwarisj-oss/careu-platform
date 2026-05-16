// GET /api/portal/orders — list all orders for the signed-in customer.
//
// Returns a narrow customer-safe column subset. Internal cost, labor /
// material, assigned tech id, and free-form internal notes never leave
// the route. Pagination via ?limit=&cursor= (cursor = last-seen
// created_at, ISO).
//
// Phase 27A — optional server-side filters, always ANDed onto the
// customer_id scope so a filter can never widen visibility:
//   ?status=    one of pending|in-progress|completed|ready-for-pickup|cancelled
//   ?branchId=  branches.code slug
//   ?from= / ?to=  created_at date range (ISO date)
//   ?q=         Job ID search (case-insensitive contains)

import { NextResponse } from "next/server";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_LABEL: Record<string, string> = {
  pending: "รอดำเนิน",
  "in-progress": "กำลังซ่อม",
  completed: "เสร็จสิ้น",
  "ready-for-pickup": "พร้อมรับ",
  cancelled: "ยกเลิก",
};

const PAYMENT_LABEL: Record<string, string> = {
  unpaid: "ยังไม่ชำระ",
  deposit: "มัดจำแล้ว",
  paid: "ชำระแล้ว",
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
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? 25), 1),
    100
  );
  const cursor = url.searchParams.get("cursor");

  // Phase 27A filters — every one is ANDed onto the customer_id scope.
  const statusFilter = (url.searchParams.get("status") ?? "").trim();
  const branchFilter = (url.searchParams.get("branchId") ?? "").trim();
  const fromFilter = (url.searchParams.get("from") ?? "").trim();
  const toFilter = (url.searchParams.get("to") ?? "").trim();
  const jobIdSearch = (url.searchParams.get("q") ?? "").trim();
  const ALLOWED_STATUS = new Set([
    "pending",
    "in-progress",
    "completed",
    "ready-for-pickup",
    "cancelled",
  ]);

  let q = admin
    .from("orders")
    .select(
      "id, job_id, branch_id, status, payment_status, service_name, item_name, price, urgent, due_date, created_at"
    )
    .eq("customer_id", session.customerId)
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (cursor) q = q.lt("created_at", cursor);
  if (statusFilter && ALLOWED_STATUS.has(statusFilter)) {
    q = q.eq("status", statusFilter);
  }
  if (branchFilter) q = q.eq("branch_id", branchFilter);
  if (fromFilter) q = q.gte("created_at", `${fromFilter}T00:00:00.000Z`);
  if (toFilter) q = q.lte("created_at", `${toFilter}T23:59:59.999Z`);
  if (jobIdSearch) q = q.ilike("job_id", `%${jobIdSearch}%`);

  const { data, error } = await q;
  if (error || !data) {
    return NextResponse.json(
      { ok: false, reason: error?.message ?? "ดึงรายการไม่สำเร็จ" },
      { status: 500 }
    );
  }
  const rows = data as Array<{
    id: string;
    job_id: string | null;
    branch_id: string | null;
    status: string;
    payment_status: string;
    service_name: string | null;
    item_name: string | null;
    price: number | string | null;
    urgent: boolean | null;
    due_date: string | null;
    created_at: string;
  }>;

  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;

  // Resolve branch labels in one batch.
  const branchSlugs = Array.from(
    new Set(visible.map((r) => r.branch_id).filter((b): b is string => !!b))
  );
  const labelByCode = new Map<string, string>();
  if (branchSlugs.length > 0) {
    const branchRes = await admin
      .from("branches")
      .select("code, short_label, short_name, name")
      .in("code", branchSlugs);
    if (!branchRes.error && branchRes.data) {
      for (const b of branchRes.data as Array<{
        code: string;
        short_label: string | null;
        short_name: string | null;
        name: string;
      }>) {
        labelByCode.set(
          b.code,
          b.short_label ?? b.short_name ?? b.name
        );
      }
    }
  }

  const orders = visible.map((r) => ({
    id: r.id,
    refId: r.id.slice(0, 8).toUpperCase(),
    jobId: r.job_id,
    branchLabel: r.branch_id ? labelByCode.get(r.branch_id) ?? null : null,
    status: r.status,
    statusLabel: STATUS_LABEL[r.status] ?? r.status,
    paymentStatus: r.payment_status,
    paymentLabel: PAYMENT_LABEL[r.payment_status] ?? r.payment_status,
    service: r.service_name ?? r.item_name ?? "งานซ่อม",
    price: Number(r.price ?? 0),
    urgent: !!r.urgent,
    dueDate: r.due_date,
    createdAt: r.created_at,
  }));

  const nextCursor = hasMore ? visible[visible.length - 1].created_at : null;
  return NextResponse.json({ ok: true, orders, nextCursor });
}
