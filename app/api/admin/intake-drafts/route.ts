// GET /api/admin/intake-drafts — the Owner/Admin review queue feed.
//
// Service-role read (intake_drafts / intake_draft_media run with RLS on +
// no policies). Each media item gets a short-lived signed read URL so the
// private bucket renders in the queue.
//
// Auth — best-effort, matching the cookieless platform: a non-admin
// session is rejected; a missing session proceeds (the /admin/intake-drafts
// page is itself RouteGuard-gated to owner / hq_admin). Branch-scoped roles
// only ever see their own branch's drafts.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { canViewAllBranches } from "@/lib/permissions";
import { issueReadUrl } from "@/lib/uploadService";
import {
  rowToIntakeDraft,
  rowToIntakeDraftMedia,
  type IntakeDraftMedia,
} from "@/lib/intakeDrafts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const REVIEW_ROLES = ["owner", "hq_admin", "branch_manager"];

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (user && !REVIEW_ROLES.includes(user.role)) {
    return NextResponse.json(
      { ok: false, error: "ไม่มีสิทธิ์เข้าถึงคิวงาน" },
      { status: 403 }
    );
  }

  // Optional ?draftId=<uuid> — fetch a single draft (used by /intake prefill).
  const draftIdParam = new URL(req.url).searchParams.get("draftId");

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "service role ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  // Branch scope — owner / hq_admin see every branch; a branch-scoped role
  // only its own. (No session → proceed; the page is already role-gated.)
  let query = admin
    .from("intake_drafts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (draftIdParam) {
    query = query.eq("id", draftIdParam);
  }
  if (user && !canViewAllBranches(user.role) && user.branchId) {
    query = query.eq("branch_id", user.branchId);
  }

  const draftRes = await query;
  if (draftRes.error) {
    console.error("[admin/intake-drafts] read failed", draftRes.error);
    return NextResponse.json(
      { ok: false, error: draftRes.error.message },
      { status: 500 }
    );
  }
  const draftRows = (draftRes.data ?? []) as Array<Record<string, unknown>>;
  const draftIds = draftRows.map((d) => String(d.id));

  // Media for all drafts in one query, then sign each path for display.
  const mediaByDraft = new Map<string, IntakeDraftMedia[]>();
  if (draftIds.length > 0) {
    const mediaRes = await admin
      .from("intake_draft_media")
      .select("*")
      .in("draft_id", draftIds)
      .order("created_at", { ascending: true });
    if (mediaRes.error) {
      console.error("[admin/intake-drafts] media read failed", mediaRes.error);
    } else {
      const rows = (mediaRes.data ?? []) as Array<Record<string, unknown>>;
      const signed = await Promise.all(
        rows.map((r) => issueReadUrl(String(r.file_url ?? ""), 10 * 60))
      );
      // W3.6 — summary log so we can confirm at a glance whether
      // any media row's signed URL came back null. issueReadUrl
      // itself logs each individual failure with the path.
      const nullCount = signed.filter((u) => u == null).length;
      if (nullCount > 0) {
        console.warn("[admin/intake-drafts] signed-URL null count", {
          totalMedia: rows.length,
          nullCount,
        });
      }
      rows.forEach((r, i) => {
        const draftId = String(r.draft_id);
        const item = rowToIntakeDraftMedia(r, signed[i]);
        const list = mediaByDraft.get(draftId);
        if (list) list.push(item);
        else mediaByDraft.set(draftId, [item]);
      });
    }
  }

  const drafts = draftRows.map((d) =>
    rowToIntakeDraft(d, mediaByDraft.get(String(d.id)) ?? [])
  );
  return NextResponse.json({ ok: true, drafts });
}
