// GET    /api/admin/crm/broadcasts/[id]  — fetch one draft (+ latest snapshot).
// PATCH  /api/admin/crm/broadcasts/[id]  — update editable fields.
// DELETE /api/admin/crm/broadcasts/[id]  — archive (soft delete via status).
//
// Branch scope mirrors the list route. No actual send.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PatchInput = {
  name?: string;
  notes?: string | null;
  segment?: Record<string, unknown>;
  templateSms?: string | null;
  templateLine?: string | null;
  channels?: string[];
  status?: "draft" | "preview" | "archived";
};

const CHANNELS = ["sms", "line", "email"];
const STATUSES = new Set(["draft", "preview", "archived"]);

async function operatorScope(): Promise<
  | { ok: true; role: string; branchCode: string | null; actorId: string }
  | { ok: false; res: NextResponse }
> {
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
  ]);
  if (guarded instanceof NextResponse) return { ok: false, res: guarded };
  const role = guarded.profile.role ?? "owner";
  const branchCode =
    role === "owner" || role === "hq_admin"
      ? null
      : (guarded.profile.branchCode ?? null);
  return { ok: true, role, branchCode, actorId: guarded.profile.id };
}

async function loadDraft(id: string) {
  const admin = getSupabaseAdmin();
  if (!admin) return { err: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" as const };
  const res = await admin
    .from("broadcast_drafts")
    .select(
      "id, name, notes, segment, template_sms, template_line, channels, status, branch_id, created_by, updated_by, created_at, updated_at"
    )
    .eq("id", id)
    .maybeSingle();
  if (res.error || !res.data) {
    return { err: res.error?.message ?? "ไม่พบ draft" };
  }
  return { data: res.data as { id: string; branch_id: string | null } & Record<string, unknown> };
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const scope = await operatorScope();
  if (!scope.ok) return scope.res;

  const { id } = await context.params;
  const draft = await loadDraft(id);
  if ("err" in draft) {
    return NextResponse.json({ ok: false, reason: draft.err }, { status: 404 });
  }

  if (scope.branchCode) {
    const branchId = draft.data.branch_id;
    if (branchId && branchId !== scope.branchCode) {
      return NextResponse.json(
        { ok: false, reason: "ไม่มีสิทธิ์ดู draft ของสาขาอื่น" },
        { status: 403 }
      );
    }
  }

  // Pull the most recent audience snapshot too — UI renders inline.
  const admin = getSupabaseAdmin()!;
  const snap = await admin
    .from("broadcast_audience_snapshots")
    .select(
      "id, total_match, reachable_line, reachable_sms, reachable_email, opted_out_line, opted_out_sms, opted_out_email, distribution, estimated_cost_thb, computed_at"
    )
    .eq("draft_id", id)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    draft: draft.data,
    latestSnapshot: snap.data ?? null,
  });
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "broadcast-draft",
    limit: 60,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "ลองมากเกินไป" },
      { status: 429 }
    );
  }

  const scope = await operatorScope();
  if (!scope.ok) return scope.res;

  const { id } = await context.params;
  const draft = await loadDraft(id);
  if ("err" in draft) {
    return NextResponse.json({ ok: false, reason: draft.err }, { status: 404 });
  }

  const branchId = draft.data.branch_id as string | null;
  if (branchId) {
    const guard = await requireBranchAccess(branchId);
    if (guard instanceof NextResponse) return guard;
  }

  let body: PatchInput;
  try {
    body = (await req.json()) as PatchInput;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (draft.data.status === "archived" && body.status !== "draft") {
    return NextResponse.json(
      { ok: false, reason: "draft ถูก archive แล้ว — restore ก่อนแก้ไข" },
      { status: 409 }
    );
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (name.length < 3 || name.length > 120) {
      return NextResponse.json(
        { ok: false, reason: "name ต้องมีความยาว 3–120 ตัวอักษร" },
        { status: 400 }
      );
    }
    patch.name = name;
  }
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.segment && typeof body.segment === "object") patch.segment = body.segment;
  if (body.templateSms !== undefined) patch.template_sms = body.templateSms;
  if (body.templateLine !== undefined) patch.template_line = body.templateLine;
  if (Array.isArray(body.channels)) {
    const channels = body.channels.filter((c) => CHANNELS.includes(c));
    if (channels.length === 0) {
      return NextResponse.json(
        { ok: false, reason: "อย่างน้อย 1 ช่องทาง" },
        { status: 400 }
      );
    }
    patch.channels = channels;
  }
  if (body.status && STATUSES.has(body.status)) {
    patch.status = body.status;
  }
  patch.updated_by = scope.actorId;

  const admin = getSupabaseAdmin()!;
  const upd = await admin
    .from("broadcast_drafts")
    .update(patch)
    .eq("id", id);
  if (upd.error) {
    return NextResponse.json(
      { ok: false, reason: upd.error.message },
      { status: 500 }
    );
  }

  await admin.from("broadcast_audit_log").insert({
    draft_id: id,
    action: body.status === "archived" ? "archive" : "update",
    actor_id: scope.actorId,
    before_value: draft.data,
    after_value: patch,
    request_ip: ip === "unknown" ? null : ip,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const ip = callerIp(req);
  const scope = await operatorScope();
  if (!scope.ok) return scope.res;

  const { id } = await context.params;
  const draft = await loadDraft(id);
  if ("err" in draft) {
    return NextResponse.json({ ok: false, reason: draft.err }, { status: 404 });
  }
  const branchId = draft.data.branch_id as string | null;
  if (branchId) {
    const guard = await requireBranchAccess(branchId);
    if (guard instanceof NextResponse) return guard;
  }

  const admin = getSupabaseAdmin()!;
  const upd = await admin
    .from("broadcast_drafts")
    .update({ status: "archived", updated_by: scope.actorId })
    .eq("id", id);
  if (upd.error) {
    return NextResponse.json(
      { ok: false, reason: upd.error.message },
      { status: 500 }
    );
  }
  await admin.from("broadcast_audit_log").insert({
    draft_id: id,
    action: "archive",
    actor_id: scope.actorId,
    before_value: draft.data,
    after_value: { status: "archived" },
    request_ip: ip === "unknown" ? null : ip,
  });
  return NextResponse.json({ ok: true });
}
