// POST /api/admin/recovery/run-worker — drain N pending failures.
//
// Auth model:
//   • requireRole(owner / hq_admin / branch_manager)
//   • branch_manager has their branch forced — the body's branchCode is
//     ignored for them, the worker only sees their profile.branchCode.
//   • owner / hq_admin may pass a branchCode filter explicitly or omit it
//     to drain across every branch.
//
// Request body:
//   { limit?: number, kinds?: string[], branchCode?: string | null }
//
// Returns the full RetryTickResult so the UI can render a per-row summary.
//
// This is the manual trigger for the worker. A future cron job (Supabase
// Cron / Vercel Cron) calls the same `runRetryTick` library directly with
// `actorId: 'cron'` — no HTTP needed.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import {
  runRetryTick,
  type RetryTickOptions,
} from "@/lib/retryWorker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  limit?: number;
  kinds?: string[];
  branchCode?: string | null;
};

const ALLOWED_KINDS = new Set([
  "order_to_sheet",
  "pricing_to_sheet",
  "debug_to_sheet",
  "customer_from_sheet",
  "expense_from_sheet",
  "line_send",
  "receipt_rebuild",
]);

export async function POST(req: Request) {
  const guarded = await requireRole(["owner", "hq_admin", "branch_manager"]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const limit = Number.isFinite(body.limit) ? Number(body.limit) : 25;
  const kinds = Array.isArray(body.kinds)
    ? body.kinds.filter((k) => typeof k === "string" && ALLOWED_KINDS.has(k))
    : null;

  // Branch scoping: managers can ONLY drain their own branch. Even if they
  // send a different branchCode in the body, we override it. Owner / HQ
  // honour the body (or `null` for all branches).
  let branchCode: string | null = null;
  if (profile.role === "branch_manager") {
    if (!profile.branchCode) {
      return NextResponse.json(
        {
          ok: false,
          reason:
            "บัญชี branch_manager ของคุณยังไม่ผูกสาขา — ติดต่อ Owner ก่อนใช้งาน worker",
        },
        { status: 403 }
      );
    }
    branchCode = profile.branchCode;
  } else {
    branchCode = body.branchCode ?? null;
  }

  const options: RetryTickOptions = {
    limit,
    kinds: kinds && kinds.length > 0
      ? (kinds as RetryTickOptions["kinds"])
      : null,
    branchCode,
    actorId: profile.id,
  };

  const result = await runRetryTick(options);

  return NextResponse.json({
    ok: true,
    actorRole: profile.role,
    scopedBranch: branchCode,
    ...result,
  });
}
