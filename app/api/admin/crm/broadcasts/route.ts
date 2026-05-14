// GET  /api/admin/crm/broadcasts — list drafts visible to the caller.
// POST /api/admin/crm/broadcasts — create a new draft.
//
// Branch scope:
//   • Owner / hq_admin: see + create any branch_id (including null).
//   • Branch_manager:   see + create drafts where branch_id matches
//                       their branch (or null for global drafts they
//                       owned originally).
//   • Front_staff / technician: 403.
//
// PHASE 15 contract: drafts are write-only-via-API, no send button
// anywhere. Status maxes out at 'preview'.

import { NextResponse } from "next/server";
import { requireBranchAccess, requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NAME_MIN = 3;
const NAME_MAX = 120;
const TEMPLATE_MAX = 4000;
const CHANNELS = ["sms", "line", "email"];

type DraftInput = {
  name?: string;
  notes?: string;
  segment?: Record<string, unknown>;
  templateSms?: string | null;
  templateLine?: string | null;
  channels?: string[];
  branchId?: string | null;
};

function sanitiseDraft(input: DraftInput): { ok: true; clean: Required<Pick<DraftInput, "name">> & DraftInput } | { ok: false; reason: string } {
  const name = (input.name ?? "").trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return { ok: false, reason: `name ต้องมีความยาว ${NAME_MIN}–${NAME_MAX} ตัวอักษร` };
  }
  const ch = Array.isArray(input.channels) ? input.channels : [];
  const channels = ch.filter((c) => CHANNELS.includes(c));
  if (channels.length === 0) {
    return { ok: false, reason: "เลือกอย่างน้อย 1 ช่องทาง (sms / line / email)" };
  }
  if (input.templateSms && input.templateSms.length > TEMPLATE_MAX) {
    return { ok: false, reason: `template SMS ยาวเกิน ${TEMPLATE_MAX} ตัวอักษร` };
  }
  if (input.templateLine && input.templateLine.length > TEMPLATE_MAX) {
    return { ok: false, reason: `template LINE ยาวเกิน ${TEMPLATE_MAX} ตัวอักษร` };
  }
  return {
    ok: true,
    clean: {
      name,
      notes: (input.notes ?? "").slice(0, 4000) || null || undefined,
      segment: input.segment && typeof input.segment === "object" ? input.segment : {},
      templateSms: input.templateSms?.trim() || null,
      templateLine: input.templateLine?.trim() || null,
      channels,
      branchId: input.branchId ?? null,
    },
  };
}

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

export async function GET(_req: Request) {
  const scope = await operatorScope();
  if (!scope.ok) return scope.res;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  let q = admin
    .from("broadcast_drafts")
    .select(
      "id, name, notes, segment, template_sms, template_line, channels, status, branch_id, created_by, created_at, updated_at"
    )
    .order("updated_at", { ascending: false })
    .limit(100);
  if (scope.branchCode) {
    q = q.or(`branch_id.is.null,branch_id.eq.${scope.branchCode}`);
  }

  const res = await q;
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, drafts: res.data ?? [] });
}

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "broadcast-draft",
    limit: 30,
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

  let body: DraftInput;
  try {
    body = (await req.json()) as DraftInput;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const cleaned = sanitiseDraft(body);
  if (!cleaned.ok) {
    return NextResponse.json(
      { ok: false, reason: cleaned.reason },
      { status: 400 }
    );
  }
  const clean = cleaned.clean;

  // Branch-scope check: a branch_manager can ONLY create drafts with
  // branch_id = own branch (or null, but null is treated as the
  // manager's branch for read purposes).
  let branchId = clean.branchId;
  if (scope.branchCode) {
    if (branchId && branchId !== scope.branchCode) {
      return NextResponse.json(
        {
          ok: false,
          reason: "ไม่มีสิทธิ์สร้าง draft ในสาขาอื่น",
        },
        { status: 403 }
      );
    }
    if (!branchId) branchId = scope.branchCode;
  }
  if (branchId) {
    const guard = await requireBranchAccess(branchId);
    if (guard instanceof NextResponse) return guard;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  const ins = await admin
    .from("broadcast_drafts")
    .insert({
      name: clean.name,
      notes: clean.notes ?? null,
      segment: clean.segment ?? {},
      template_sms: clean.templateSms ?? null,
      template_line: clean.templateLine ?? null,
      channels: clean.channels,
      status: "draft",
      branch_id: branchId,
      created_by: scope.actorId,
      updated_by: scope.actorId,
    })
    .select("id")
    .single();
  if (ins.error || !ins.data) {
    return NextResponse.json(
      { ok: false, reason: ins.error?.message ?? "Insert failed" },
      { status: 500 }
    );
  }
  const newId = (ins.data as { id: string }).id;

  await admin.from("broadcast_audit_log").insert({
    draft_id: newId,
    action: "create",
    actor_id: scope.actorId,
    after_value: {
      name: clean.name,
      channels: clean.channels,
      branch_id: branchId,
    },
    request_ip: ip === "unknown" ? null : ip,
  });

  return NextResponse.json({ ok: true, id: newId });
}
