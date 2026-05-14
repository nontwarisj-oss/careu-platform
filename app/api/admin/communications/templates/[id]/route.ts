// GET    /api/admin/communications/templates/[id] — fetch + versions.
// DELETE /api/admin/communications/templates/[id] — soft-disable (set enabled=false).
//
// Versions are NEVER physically deleted — that's the "immutable
// history" guarantee.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  const { id } = await context.params;
  const [tplRes, versRes] = await Promise.all([
    admin
      .from("email_templates")
      .select(
        "id, slug, name, subject, preview_text, body_plain, body_html, variables, channels, enabled, current_version, branch_id, updated_at, created_at"
      )
      .eq("id", id)
      .maybeSingle(),
    admin
      .from("email_template_versions")
      .select(
        "id, version, name, subject, preview_text, body_plain, body_html, variables, channels, edited_by, edit_reason, created_at"
      )
      .eq("template_id", id)
      .order("version", { ascending: false })
      .limit(50),
  ]);
  if (tplRes.error || !tplRes.data) {
    return NextResponse.json(
      { ok: false, reason: tplRes.error?.message ?? "ไม่พบ template" },
      { status: 404 }
    );
  }
  return NextResponse.json({
    ok: true,
    template: tplRes.data,
    versions: versRes.data ?? [],
  });
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const actorId = guarded.profile.id;
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  const { id } = await context.params;
  const upd = await admin
    .from("email_templates")
    .update({ enabled: false, updated_by: actorId })
    .eq("id", id);
  if (upd.error) {
    return NextResponse.json(
      { ok: false, reason: upd.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
