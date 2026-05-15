// GET  /api/admin/system/escalation-recipients — list all rows.
// POST /api/admin/system/escalation-recipients — create / update / delete.
//
// Phase 25. Owner / hq_admin only. Manages the role-tiered alert
// escalation contact list (escalation_recipients).

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import {
  listEscalationRecipients,
  __resetEscalationRecipientsCache,
} from "@/lib/escalationRecipients";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROLE_TIERS = new Set([
  "owner",
  "hq_admin",
  "branch_manager",
  "technician_lead",
]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET() {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const rows = await listEscalationRecipients();
  return NextResponse.json({ ok: true, rows });
}

type Body = {
  id?: string;
  roleTier?: string;
  branchId?: string | null;
  label?: string | null;
  email?: string | null;
  lineTarget?: string | null;
  minSeverity?: "warning" | "critical";
  mutedUntil?: string | null;
  enabled?: boolean;
  delete?: boolean;
};

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "escalation-recipients-write",
    limit: 40,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "ลองมากเกินไป" },
      { status: 429 }
    );
  }
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const actorId = guarded.profile.id;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  // Delete path.
  if (body.delete === true) {
    if (!body.id) {
      return NextResponse.json(
        { ok: false, reason: "id required to delete" },
        { status: 400 }
      );
    }
    const del = await admin
      .from("escalation_recipients")
      .delete()
      .eq("id", body.id);
    if (del.error) {
      return NextResponse.json(
        { ok: false, reason: del.error.message },
        { status: 500 }
      );
    }
    __resetEscalationRecipientsCache();
    return NextResponse.json({ ok: true, deleted: true });
  }

  // Validate.
  if (!body.roleTier || !ROLE_TIERS.has(body.roleTier)) {
    return NextResponse.json(
      { ok: false, reason: "roleTier ต้องเป็น owner/hq_admin/branch_manager/technician_lead" },
      { status: 400 }
    );
  }
  const email = body.email?.trim().toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { ok: false, reason: `อีเมลไม่ถูกต้อง: ${email}` },
      { status: 400 }
    );
  }
  const lineTarget = body.lineTarget?.trim() || null;
  if (!email && !lineTarget) {
    return NextResponse.json(
      { ok: false, reason: "ต้องมี email หรือ LINE target อย่างน้อยหนึ่งอย่าง" },
      { status: 400 }
    );
  }

  const payload = {
    role_tier: body.roleTier,
    branch_id: body.branchId?.trim() || null,
    label: body.label?.trim() || null,
    email,
    line_target: lineTarget,
    min_severity: body.minSeverity === "critical" ? "critical" : "warning",
    muted_until: body.mutedUntil || null,
    enabled: body.enabled !== false,
    updated_at: new Date().toISOString(),
    updated_by: actorId,
  };

  if (body.id) {
    const upd = await admin
      .from("escalation_recipients")
      .update(payload)
      .eq("id", body.id);
    if (upd.error) {
      return NextResponse.json(
        { ok: false, reason: upd.error.message },
        { status: 500 }
      );
    }
  } else {
    const ins = await admin.from("escalation_recipients").insert(payload);
    if (ins.error) {
      return NextResponse.json(
        { ok: false, reason: ins.error.message },
        { status: 500 }
      );
    }
  }
  __resetEscalationRecipientsCache();
  return NextResponse.json({ ok: true });
}
