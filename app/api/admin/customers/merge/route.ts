// POST /api/admin/customers/merge — safe duplicate-customer merge.
//
// Store Ops Hardening — customer data integrity. The same person
// sometimes ends up as two rows (sheet import + a walk-in re-entry).
// This folds a DUPLICATE into a SURVIVOR:
//
//   1. Every order is reassigned duplicate → survivor (orders.customer_id),
//      so visit count + lifetime spend recombine on the survivor.
//   2. Each reassigned order gets an order_audit_log row — the merge is
//      auditable per ticket.
//   3. The duplicate row is deleted. If a foreign key blocks the delete
//      it is neutralised instead (phone cleared so it stops surfacing as
//      a duplicate) — the end state is always clean.
//
// owner / hq_admin only — duplicate resolution is an HQ data task, and
// scoping it there keeps branch isolation intact (no branch_manager
// reaching across branches).
//
// `dryRun: true` returns the preview (how many orders would move)
// without writing anything.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  survivorId?: string;
  duplicateId?: string;
  dryRun?: boolean;
};

type CustomerRow = {
  id: string;
  name: string;
  phone: string | null;
  branch_id: string | null;
};

export async function POST(req: Request) {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }
  const survivorId = (body.survivorId ?? "").trim();
  const duplicateId = (body.duplicateId ?? "").trim();

  if (!survivorId || !duplicateId) {
    return NextResponse.json(
      { ok: false, reason: "ต้องระบุลูกค้าทั้งสองราย" },
      { status: 400 }
    );
  }
  if (survivorId === duplicateId) {
    return NextResponse.json(
      { ok: false, reason: "เลือกลูกค้าคนละรายกัน" },
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

  // Validate both customers exist.
  const { data: rows, error: rowsErr } = await admin
    .from("customers")
    .select("id, name, phone, branch_id")
    .in("id", [survivorId, duplicateId]);
  if (rowsErr) {
    return NextResponse.json(
      { ok: false, reason: rowsErr.message },
      { status: 500 }
    );
  }
  const list = (rows ?? []) as CustomerRow[];
  const survivor = list.find((c) => c.id === survivorId) ?? null;
  const duplicate = list.find((c) => c.id === duplicateId) ?? null;
  if (!survivor || !duplicate) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบลูกค้าที่เลือก" },
      { status: 404 }
    );
  }

  // Orders currently linked to the duplicate.
  const { data: orderRows, error: ordErr } = await admin
    .from("orders")
    .select("id")
    .eq("customer_id", duplicateId);
  if (ordErr) {
    return NextResponse.json(
      { ok: false, reason: ordErr.message },
      { status: 500 }
    );
  }
  const orderIds = (orderRows ?? []).map((r) => String((r as { id: string }).id));

  // ---- Preview ----------------------------------------------------------
  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      survivor: { id: survivor.id, name: survivor.name, phone: survivor.phone },
      duplicate: {
        id: duplicate.id,
        name: duplicate.name,
        phone: duplicate.phone,
      },
      ordersToMove: orderIds.length,
    });
  }

  // ---- Execute ----------------------------------------------------------
  // 1. Reassign every order to the survivor.
  if (orderIds.length > 0) {
    const upd = await admin
      .from("orders")
      .update({ customer_id: survivorId })
      .eq("customer_id", duplicateId);
    if (upd.error) {
      return NextResponse.json(
        { ok: false, reason: `ย้ายใบงานไม่สำเร็จ: ${upd.error.message}` },
        { status: 500 }
      );
    }
  }

  // 2. Audit each reassigned order (best-effort).
  if (orderIds.length > 0) {
    const auditRows = orderIds.map((id) => ({
      order_id: id,
      action: "customer_merged",
      before_value: duplicateId,
      after_value: survivorId,
      changed_by: profile.id ?? null,
    }));
    const auditRes = await admin.from("order_audit_log").insert(auditRows);
    if (
      auditRes.error &&
      !/column .* does not exist|schema cache|relation .* does not exist/i.test(
        auditRes.error.message
      )
    ) {
      console.warn("[customers/merge] audit write failed", auditRes.error.message);
    }
  }

  // 3. Remove the duplicate. If an FK blocks the delete, neutralise it
  //    so it no longer surfaces as a duplicate.
  let duplicateRemoved = true;
  const del = await admin.from("customers").delete().eq("id", duplicateId);
  if (del.error) {
    duplicateRemoved = false;
    await admin
      .from("customers")
      .update({
        name: `(รวมแล้ว) ${duplicate.name}`,
        phone: null,
        normalized_phone: null,
      })
      .eq("id", duplicateId);
  }

  return NextResponse.json({
    ok: true,
    ordersMoved: orderIds.length,
    duplicateRemoved,
    survivorId,
  });
}
