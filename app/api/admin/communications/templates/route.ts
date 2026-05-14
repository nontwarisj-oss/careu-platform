// GET  /api/admin/communications/templates       — list all templates.
// POST /api/admin/communications/templates       — create new template.
//
// Owner / hq_admin only. Templates are global resources — branch_id
// scoping applies to which trigger jobs use them, not who can see
// the template body.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import {
  saveTemplateWithHistory,
  type SaveTemplateInput,
} from "@/lib/emailTemplateService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  const res = await admin
    .from("email_templates")
    .select(
      "id, slug, name, subject, preview_text, body_plain, body_html, variables, channels, enabled, current_version, branch_id, updated_at"
    )
    .order("slug", { ascending: true });
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, templates: res.data ?? [] });
}

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "templates-write",
    limit: 30,
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

  let body: SaveTemplateInput & { id?: string | null };
  try {
    body = (await req.json()) as SaveTemplateInput & { id?: string | null };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  if (body.id === null) body.id = undefined;
  body.actorId = actorId;
  const res = await saveTemplateWithHistory(body);
  if (!res.ok) {
    return NextResponse.json({ ok: false, reason: res.reason }, { status: 400 });
  }
  return NextResponse.json({ ok: true, id: res.id, version: res.version });
}
