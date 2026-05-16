// POST /api/admin/upload-url — signed upload URL for OPS-side photos.
//
// The operator counterpart of /api/public/upload-url: front-counter
// staff attach photos to a repair item (damage reference, before/after).
// Reuses lib/uploadService.issueUploadUrl with the existing "order"
// scope — no new storage system.
//
// At intake the order does not exist yet, so a client-side grouping
// token stands in for the order id in the storage path; the uploaded
// paths are saved onto order_items.image_paths when the order is
// created. After intake the real orderId is passed.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { issueUploadUrl } from "@/lib/uploadService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  mime?: string;
  size?: number;
  branchCode?: string | null;
  orderId?: string | null;
  groupingToken?: string | null;
};

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

  const declaredSize =
    typeof body.size === "number" && Number.isFinite(body.size)
      ? body.size
      : null;
  const branchCode = (body.branchCode ?? "").trim() || "no-branch";
  // The order-scope path segment: the real order id once it exists, else
  // a client grouping token so one intake's photos cluster together.
  const orderId =
    (body.orderId ?? "").trim() ||
    (body.groupingToken ?? "").trim() ||
    "pending";

  const result = await issueUploadUrl({
    scope: { scope: "order", branchCode, orderId },
    mime: body.mime ?? "",
    declaredSize,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
