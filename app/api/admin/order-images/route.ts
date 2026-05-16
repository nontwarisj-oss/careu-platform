// POST /api/admin/order-images — signed READ URLs for OPS photo viewing.
//
// order_items.image_paths holds storage object paths in the private
// customer-uploads bucket. The operations UI cannot render those
// directly — it posts the paths here and gets back short-lived signed
// URLs. Reuses lib/uploadService.issueReadUrl.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { issueReadUrl } from "@/lib/uploadService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { paths?: unknown };

export async function POST(req: Request) {
  const guarded = await requireRole([
    "owner",
    "hq_admin",
    "branch_manager",
    "front_staff",
    "technician",
  ]);
  if (guarded instanceof NextResponse) return guarded;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const paths = Array.isArray(body.paths)
    ? (body.paths.filter((p) => typeof p === "string") as string[]).slice(
        0,
        60
      )
    : [];

  const urls: Record<string, string> = {};
  for (const path of paths) {
    const signed = await issueReadUrl(path, 5 * 60);
    if (signed) urls[path] = signed;
  }
  return NextResponse.json({ ok: true, urls });
}
