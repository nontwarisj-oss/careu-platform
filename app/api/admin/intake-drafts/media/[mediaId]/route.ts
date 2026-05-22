// GET /api/admin/intake-drafts/media/[mediaId] — Phase W3.8 media proxy.
//
// Streams an intake_draft_media image through the server using the
// service-role key, instead of handing the browser a signed read URL.
// The signed-URL approach proved unreliable for thumbnail rendering;
// proxying removes the browser ↔ Storage hop (CORS, token, host
// mismatch) the same way the W3.3 upload route did for uploads.
//
// Security:
//   • Service-role download only. The key never leaves the server.
//   • No signed URL is generated or exposed.
//   • Image media only (the queue preview is image-only today).
//   • Best-effort role gate matching the queue route: a non-admin
//     session is rejected; a missing session proceeds (the page is
//     RouteGuard-gated to owner / hq_admin). Branch isolation is
//     enforced against the parent draft.
//   • Response is binary with the stored/looked-up Content-Type and a
//     private, short cache window.
//
// Errors:
//   400 — unsupported media type (non-image)
//   401 — (not used; missing session proceeds, see above)
//   403 — caller's branch can't see this draft
//   404 — media row or storage object not found
//   500 — storage download failed / service role unset

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { canViewAllBranches } from "@/lib/permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const BUCKET = "customer-uploads";
const REVIEW_ROLES = ["owner", "hq_admin", "branch_manager"];

// Map a stored file extension to a Content-Type when the row has no
// explicit mime. The bucket only ever holds the formats the public
// upload route allows.
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

type Ctx = { params: Promise<{ mediaId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { mediaId } = await params;
  if (!mediaId) {
    return NextResponse.json(
      { ok: false, error: "media id required" },
      { status: 400 }
    );
  }

  // Role gate — reject a logged-in non-review user; allow a missing
  // session (page is RouteGuard-gated). Mirrors the queue feed.
  const user = await getCurrentUser();
  if (user && !REVIEW_ROLES.includes(user.role)) {
    return NextResponse.json(
      { ok: false, error: "ไม่มีสิทธิ์เข้าถึงสื่อ" },
      { status: 403 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.warn("[intake-media-proxy] admin client unavailable — env not set");
    return NextResponse.json(
      { ok: false, error: "service role ยังไม่ได้ตั้งค่า" },
      { status: 500 }
    );
  }

  const mediaRes = await admin
    .from("intake_draft_media")
    .select("id, draft_id, media_type, file_url")
    .eq("id", mediaId)
    .maybeSingle();
  if (mediaRes.error) {
    console.warn("[intake-media-proxy] media lookup failed", {
      mediaId,
      error: mediaRes.error.message,
    });
    return NextResponse.json(
      { ok: false, error: "อ่านข้อมูลสื่อไม่สำเร็จ" },
      { status: 500 }
    );
  }
  const media = mediaRes.data as
    | {
        id: string;
        draft_id: string;
        media_type: string;
        file_url: string;
      }
    | null;
  if (!media) {
    return NextResponse.json(
      { ok: false, error: "ไม่พบสื่อนี้" },
      { status: 404 }
    );
  }

  if (media.media_type !== "image") {
    return NextResponse.json(
      { ok: false, error: "รองรับเฉพาะรูปภาพในตอนนี้" },
      { status: 400 }
    );
  }

  const path = String(media.file_url ?? "").trim();
  if (!path) {
    console.warn("[intake-media-proxy] empty file_url", { mediaId });
    return NextResponse.json(
      { ok: false, error: "ไม่มี path ของไฟล์" },
      { status: 404 }
    );
  }

  // Branch isolation — a branch-scoped reviewer only sees their branch.
  if (user && !canViewAllBranches(user.role) && user.branchId) {
    const draftRes = await admin
      .from("intake_drafts")
      .select("branch_id")
      .eq("id", media.draft_id)
      .maybeSingle();
    const draftBranch =
      (draftRes.data as { branch_id: string | null } | null)?.branch_id ??
      null;
    if (draftBranch && draftBranch !== user.branchId) {
      return NextResponse.json(
        { ok: false, error: "สื่ออยู่คนละสาขา" },
        { status: 403 }
      );
    }
  }

  // Download via service role. No signed URL, no browser ↔ Storage hop.
  const startMs = Date.now();
  const dl = await admin.storage.from(BUCKET).download(path);
  const elapsedMs = Date.now() - startMs;
  if (dl.error || !dl.data) {
    console.warn("[intake-media-proxy] storage download FAILED", {
      mediaId,
      bucket: BUCKET,
      path,
      elapsedMs,
      error: dl.error?.message ?? "no data",
    });
    return NextResponse.json(
      {
        ok: false,
        error: `ดาวน์โหลดไฟล์ไม่สำเร็จ: ${dl.error?.message ?? "ไม่พบไฟล์ใน Storage"}`,
      },
      { status: dl.error?.message?.toLowerCase().includes("not found") ? 404 : 500 }
    );
  }

  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  // supabase-js download() returns a Blob; its .type may be empty, so
  // fall back to the extension map, then a safe default.
  const blobType = (dl.data as Blob).type;
  const contentType = blobType || EXT_MIME[ext] || "application/octet-stream";

  const arrayBuffer = await dl.data.arrayBuffer();
  console.log("[intake-media-proxy] served", {
    mediaId,
    path,
    contentType,
    bytes: arrayBuffer.byteLength,
    elapsedMs,
  });

  return new NextResponse(arrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(arrayBuffer.byteLength),
      // Private — this is customer media behind an admin gate. Short
      // cache so the queue doesn't re-fetch on every render, but it
      // never lands in a shared CDN cache.
      "Cache-Control": "private, max-age=300",
    },
  });
}
