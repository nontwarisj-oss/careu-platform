// POST /api/admin/recovery/bulk-resolve — mark up to N sync_failures rows
// as resolved in one call.
//
// Auth model mirrors /api/admin/recovery/resolve: owner / hq_admin /
// branch_manager. Per-row branch check enforces isolation — a manager who
// somehow submits a foreign-branch failureId gets a 403 for that row but
// the loop continues for the rows they DO own.
//
// Request body:
//   { failureIds: string[], note?: string }
//
// Response:
//   { ok: true, resolved: N, skipped: M, items: [{ failureId, ok, reason? }] }

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { canViewAllBranches } from "@/lib/permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HARD_CAP = 100;

type Body = {
  failureIds?: unknown;
  note?: string;
};

type ItemOutcome = {
  failureId: string;
  ok: boolean;
  reason?: string;
  alreadyResolved?: boolean;
};

export async function POST(req: Request) {
  const guarded = await requireRole(["owner", "hq_admin", "branch_manager"]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!Array.isArray(body.failureIds) || body.failureIds.length === 0) {
    return NextResponse.json(
      { ok: false, reason: "Missing failureIds[]" },
      { status: 400 }
    );
  }

  const ids = body.failureIds
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .slice(0, HARD_CAP);
  if (ids.length === 0) {
    return NextResponse.json(
      { ok: false, reason: "No valid failureIds in body" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      {
        ok: false,
        reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า",
      },
      { status: 503 }
    );
  }

  // Stamp every row in this run with a shared bulkActionId so admins can
  // group them in the payload jsonb later.
  const bulkActionId = `bulk-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const now = new Date().toISOString();
  const items: ItemOutcome[] = [];
  const seesAll = canViewAllBranches(profile.role);

  // Pull all rows in one query so branch checks happen consistently.
  const fetched = await admin
    .from("sync_failures")
    .select("id, branch_id, status, payload")
    .in("id", ids);
  if (fetched.error) {
    return NextResponse.json(
      { ok: false, reason: fetched.error.message },
      { status: 500 }
    );
  }
  const fetchedRows = (fetched.data ?? []) as Array<{
    id: string;
    branch_id: string | null;
    status: string;
    payload: Record<string, unknown> | null;
  }>;
  const byId = new Map(fetchedRows.map((r) => [r.id, r]));

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      items.push({ failureId: id, ok: false, reason: "not found" });
      continue;
    }
    // Branch isolation: managers can only touch their own branch.
    if (!seesAll) {
      if (!profile.branchCode || row.branch_id !== profile.branchCode) {
        items.push({
          failureId: id,
          ok: false,
          reason: "ไม่มีสิทธิ์เข้าถึงสาขาของรายการนี้",
        });
        continue;
      }
    }
    if (row.status === "resolved") {
      items.push({ failureId: id, ok: true, alreadyResolved: true });
      continue;
    }
    const payload: Record<string, unknown> = {
      ...(row.payload ?? {}),
      bulkActionId,
      resolvedBy: profile.id,
      resolvedAt: now,
    };
    if (body.note && body.note.trim().length > 0) {
      payload.resolutionNote = body.note.trim();
    }
    const upd = await admin
      .from("sync_failures")
      .update({
        status: "resolved",
        resolved_at: now,
        payload,
      })
      .eq("id", id);
    if (upd.error) {
      items.push({ failureId: id, ok: false, reason: upd.error.message });
      continue;
    }
    items.push({ failureId: id, ok: true });
  }

  const resolved = items.filter((i) => i.ok && !i.alreadyResolved).length;
  const skipped = items.filter((i) => !i.ok || i.alreadyResolved).length;

  return NextResponse.json({
    ok: true,
    bulkActionId,
    resolved,
    skipped,
    items,
  });
}
