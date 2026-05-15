// GET /api/admin/system/incident-export — downloadable incident package.
//
// Phase 25. Query params:
//   • notificationId — a notification-centric incident, OR
//   • alertEventId   — an alert-centric incident
//   • format=json (default) | md
//
// owner / hq_admin only. Read-only. Returns the package as a file
// download (Content-Disposition: attachment).

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import {
  buildIncidentPackage,
  incidentToMarkdown,
} from "@/lib/incidentExport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;

  const url = new URL(req.url);
  const notificationId = url.searchParams.get("notificationId") ?? undefined;
  const alertEventId = url.searchParams.get("alertEventId") ?? undefined;
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();

  if (!notificationId && !alertEventId) {
    return NextResponse.json(
      { ok: false, reason: "notificationId หรือ alertEventId required" },
      { status: 400 }
    );
  }

  const pkg = await buildIncidentPackage({ notificationId, alertEventId });
  if (!pkg) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบ incident" },
      { status: 404 }
    );
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const idPart = (notificationId ?? alertEventId ?? "x").slice(0, 8);

  if (format === "md") {
    const md = incidentToMarkdown(pkg);
    return new NextResponse(md, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="incident-${pkg.kind}-${idPart}-${stamp}.md"`,
      },
    });
  }

  return new NextResponse(JSON.stringify(pkg, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="incident-${pkg.kind}-${idPart}-${stamp}.json"`,
    },
  });
}
