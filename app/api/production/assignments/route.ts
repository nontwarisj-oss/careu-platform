// Phase J — /api/production/assignments.
//
// GET  → assignments (filterable by date / technician / status) joined with
//        order + technician info, plus per-technician daily KPI.
// POST → { action: "create" } assigns a paid order to a technician;
//        { action: "update" } moves an assignment through its workflow.
//
// Service-role; best-effort owner/hq_admin/branch_manager gate.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  calculateTechnicianDailyKpi,
  isAssignmentStatus,
  orderPriority,
} from "@/lib/productionQueue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MANAGE_ROLES = ["owner", "hq_admin", "branch_manager"];
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function denied() {
  return NextResponse.json(
    { ok: false, error: "ไม่มีสิทธิ์จัดการงานช่าง" },
    { status: 403 }
  );
}

// ---------- GET ------------------------------------------------------------

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (user && !MANAGE_ROLES.includes(user.role)) return denied();

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "service role ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const technicianId = url.searchParams.get("technicianId") || "";
  const status = url.searchParams.get("status") || "";
  // open=1 → the technician "my jobs" view: still-open assignments across
  // every date (status not DONE/CANCELLED), instead of one date.
  const openOnly = url.searchParams.get("open") === "1";

  let query = admin
    .from("work_assignments")
    .select("*")
    .order("created_at", { ascending: false });
  if (openOnly) {
    query = query.not("status", "in", "(DONE,CANCELLED)");
  } else {
    query = query.eq("assigned_date", date);
  }
  if (technicianId) query = query.eq("technician_id", technicianId);
  if (status) query = query.eq("status", status);

  const waRes = await query;
  if (waRes.error) {
    return NextResponse.json(
      { ok: false, error: waRes.error.message },
      { status: 500 }
    );
  }
  const waRows = (waRes.data ?? []) as Array<Record<string, unknown>>;

  // Order + technician lookups.
  const orderIds = Array.from(new Set(waRows.map((w) => String(w.order_id))));
  const techIds = Array.from(
    new Set(waRows.map((w) => String(w.technician_id)))
  );

  const orderById = new Map<string, Record<string, unknown>>();
  if (orderIds.length > 0) {
    const wide = await admin
      .from("orders")
      .select("id, job_id, customer_name, item_name, price")
      .in("id", orderIds);
    let orderRows = (wide.data ?? []) as unknown as Array<
      Record<string, unknown>
    >;
    if (wide.error) {
      const narrow = await admin
        .from("orders")
        .select("id, customer_name, item_name, price")
        .in("id", orderIds);
      orderRows = (narrow.data ?? []) as unknown as Array<
        Record<string, unknown>
      >;
    }
    for (const o of orderRows) {
      orderById.set(String(o.id), o);
    }
  }

  const techById = new Map<string, string>();
  if (techIds.length > 0) {
    const tRes = await admin
      .from("technician_profiles")
      .select("id, display_name")
      .in("id", techIds);
    for (const t of (tRes.data ?? []) as Array<Record<string, unknown>>) {
      techById.set(String(t.id), String(t.display_name ?? ""));
    }
  }

  const assignments = waRows.map((w) => {
    const order = orderById.get(String(w.order_id));
    return {
      id: String(w.id),
      orderId: String(w.order_id),
      jobId: order?.job_id ? String(order.job_id) : null,
      customerName: order ? String(order.customer_name ?? "") : "",
      itemName: order ? String(order.item_name ?? "") : "",
      price: order ? Number(order.price) || 0 : 0,
      technicianId: String(w.technician_id),
      technicianName: techById.get(String(w.technician_id)) ?? "",
      assignedDate: String(w.assigned_date ?? ""),
      dueDate: w.due_date ? String(w.due_date) : null,
      priority: String(w.priority ?? "NORMAL"),
      status: String(w.status ?? "ASSIGNED"),
      adminNote: w.admin_note ? String(w.admin_note) : null,
      technicianNote: w.technician_note ? String(w.technician_note) : null,
      createdAt: String(w.created_at ?? ""),
    };
  });

  // Per-technician KPI for the date.
  const kpiTechIds =
    techIds.length > 0
      ? techIds
      : technicianId
        ? [technicianId]
        : [];
  const kpis = await Promise.all(
    kpiTechIds.map((id) => calculateTechnicianDailyKpi(admin, id, date))
  );
  const kpisWithName = kpis.map((k) => ({
    ...k,
    technicianName: techById.get(k.technicianId) ?? "",
  }));

  // Active technicians — for the page's filter / technician selector.
  const allTechRes = await admin
    .from("technician_profiles")
    .select("id, display_name")
    .eq("active", true)
    .order("display_name", { ascending: true });
  const technicians = ((allTechRes.data ?? []) as Array<Record<string, unknown>>).map(
    (t) => ({ id: String(t.id), displayName: String(t.display_name ?? "") })
  );

  return NextResponse.json({
    ok: true,
    date,
    assignments,
    kpis: kpisWithName,
    technicians,
  });
}

// ---------- POST -----------------------------------------------------------

type PostBody = {
  action?: string;
  orderId?: string;
  technicianId?: string;
  adminNote?: string;
  assignmentId?: string;
  status?: string;
  technicianNote?: string;
};

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (user && !MANAGE_ROLES.includes(user.role)) return denied();

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "service role ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  // ---- create assignment ------------------------------------------------
  if (body.action === "create") {
    const orderId = (body.orderId ?? "").trim();
    const technicianId = (body.technicianId ?? "").trim();
    if (!orderId || !technicianId) {
      return NextResponse.json(
        { ok: false, error: "ต้องระบุใบงานและช่าง" },
        { status: 400 }
      );
    }

    // Load the order to derive priority + due date.
    const wideO = await admin
      .from("orders")
      .select("id, urgent, due_date, item_name")
      .eq("id", orderId)
      .maybeSingle();
    let order = (wideO.data ?? null) as Record<string, unknown> | null;
    if (wideO.error) {
      const narrowO = await admin
        .from("orders")
        .select("id, item_name")
        .eq("id", orderId)
        .maybeSingle();
      order = (narrowO.data ?? null) as Record<string, unknown> | null;
    }
    if (!order) {
      return NextResponse.json(
        { ok: false, error: "ไม่พบใบงานนี้" },
        { status: 404 }
      );
    }
    const itemName = String(order.item_name ?? "");
    const urgent =
      order.urgent === true ||
      itemName.includes("ด่วน") ||
      itemName.includes("[ด่วน]");
    const dueDate = order.due_date
      ? String(order.due_date).slice(0, 10)
      : null;
    const priority = orderPriority(urgent, dueDate);

    const assignedBy = user && UUID_RE.test(user.uid) ? user.uid : null;

    const insertRes = await admin
      .from("work_assignments")
      .insert({
        order_id: orderId,
        technician_id: technicianId,
        due_date: dueDate,
        priority,
        status: "ASSIGNED",
        assigned_by: assignedBy,
        admin_note: body.adminNote?.trim() || null,
      })
      .select("id")
      .single();

    if (insertRes.error) {
      // Partial unique index → the order already has an active assignment.
      if (insertRes.error.code === "23505") {
        return NextResponse.json(
          { ok: false, error: "ใบงานนี้ถูกมอบหมายให้ช่างไปแล้ว" },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { ok: false, error: insertRes.error.message },
        { status: 500 }
      );
    }

    // Mirror onto orders.assigned_technician_id (keeps the legacy KPI view
    // + the intake technician picker consistent). Best-effort.
    const upd = await admin
      .from("orders")
      .update({ assigned_technician_id: technicianId })
      .eq("id", orderId);
    if (upd.error) {
      console.warn(
        "[assignments] orders.assigned_technician_id mirror failed",
        upd.error.message
      );
    }

    return NextResponse.json({
      ok: true,
      assignmentId: (insertRes.data as { id: string }).id,
      priority,
    });
  }

  // ---- update assignment ------------------------------------------------
  if (body.action === "update") {
    const assignmentId = (body.assignmentId ?? "").trim();
    if (!assignmentId) {
      return NextResponse.json(
        { ok: false, error: "ต้องระบุ assignmentId" },
        { status: 400 }
      );
    }
    const patch: Record<string, unknown> = {};
    if (body.status !== undefined) {
      if (!isAssignmentStatus(body.status)) {
        return NextResponse.json(
          { ok: false, error: `สถานะ "${body.status}" ไม่ถูกต้อง` },
          { status: 400 }
        );
      }
      patch.status = body.status;
    }
    if (body.adminNote !== undefined) {
      patch.admin_note = body.adminNote.trim() || null;
    }
    if (body.technicianNote !== undefined) {
      patch.technician_note = body.technicianNote.trim() || null;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { ok: false, error: "ไม่มีข้อมูลที่จะอัปเดต" },
        { status: 400 }
      );
    }

    const res = await admin
      .from("work_assignments")
      .update(patch)
      .eq("id", assignmentId)
      .select("order_id, status")
      .maybeSingle();
    if (res.error) {
      return NextResponse.json(
        { ok: false, error: res.error.message },
        { status: 500 }
      );
    }
    if (!res.data) {
      return NextResponse.json(
        { ok: false, error: "ไม่พบงานที่มอบหมายนี้" },
        { status: 404 }
      );
    }

    // A cancelled assignment frees the order for reassignment.
    if (patch.status === "CANCELLED") {
      const row = res.data as { order_id: string };
      await admin
        .from("orders")
        .update({ assigned_technician_id: null })
        .eq("id", row.order_id);
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { ok: false, error: `ไม่รู้จัก action "${body.action}"` },
    { status: 400 }
  );
}
