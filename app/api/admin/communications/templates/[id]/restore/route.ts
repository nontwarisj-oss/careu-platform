// POST /api/admin/communications/templates/[id]/restore
// Body: { versionId: string, reason?: string }
//
// Restores a previous version. Implementation: snapshot the current
// content as a new version FIRST, then overwrite with the chosen
// version's payload. This means the history grows monotonically —
// you can always step back further.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { restoreTemplateVersion } from "@/lib/emailTemplateService";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "template-restore",
    limit: 20,
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

  const { id: templateId } = await context.params;
  let body: { versionId?: string; reason?: string };
  try {
    body = (await req.json()) as { versionId?: string; reason?: string };
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  if (!body.versionId) {
    return NextResponse.json(
      { ok: false, reason: "versionId required" },
      { status: 400 }
    );
  }

  const res = await restoreTemplateVersion({
    templateId,
    versionId: body.versionId,
    actorId,
    reason: body.reason ?? "restored via admin UI",
  });
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, reason: res.reason },
      { status: 400 }
    );
  }
  return NextResponse.json({
    ok: true,
    templateId: res.id,
    version: res.version,
  });
}
