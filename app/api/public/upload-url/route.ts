// POST /api/public/upload-url — anonymous upload URL for the /quote form.
//
// Rate-limited 10/hour/IP. Scope is always "quote" + the customer's
// chosen branch slug. The path includes a "pending" token so multiple
// uploads on the same form attempt cluster together; once the quote is
// inserted, the admin's triage tool can re-locate the photos via the
// `photos` JSONB on quote_requests.

import { NextResponse } from "next/server";
import { issueUploadUrl } from "@/lib/uploadService";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  mime?: string;
  size?: number;
  branchCode?: string | null;
  /** Optional client-side id grouping the uploads from one form attempt.
   *  Sanitised before use. */
  groupingToken?: string | null;
};

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "public-upload-url",
    limit: 10,
    windowMs: 60 * 60 * 1000, // 10 per hour
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "Too many requests" },
      { status: 429 }
    );
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }
  const mime = body.mime ?? "";
  const declaredSize =
    typeof body.size === "number" && Number.isFinite(body.size)
      ? body.size
      : null;

  // Validate branch when present so an attacker can't dump junk into a
  // random folder named after a non-existent branch.
  let branchCode = (body.branchCode ?? "").trim();
  if (branchCode) {
    const admin = getSupabaseAdmin();
    if (admin) {
      const branch = await admin
        .from("branches")
        .select("code, is_active")
        .eq("code", branchCode)
        .maybeSingle();
      const row = branch.data as
        | { code: string; is_active: boolean }
        | null;
      if (!row || row.is_active === false) {
        branchCode = "no-branch";
      }
    }
  } else {
    branchCode = "no-branch";
  }

  const groupingToken = (body.groupingToken ?? "").trim() || null;

  const result = await issueUploadUrl({
    scope: {
      scope: "quote",
      branchCode,
      quoteRequestId: groupingToken,
    },
    mime,
    declaredSize,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
