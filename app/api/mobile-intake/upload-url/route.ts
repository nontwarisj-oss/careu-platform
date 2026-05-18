// POST /api/mobile-intake/upload-url — signed upload URL for draft media.
//
// The mobile staff flow has NO login (front counter, no computer), so this
// route is intentionally NOT session-gated — a hard requireRole() would
// 401 every phone. It only mints a short-lived signed PUT URL into the
// private customer-uploads bucket under an `intake-drafts/` prefix; the
// service-role key never leaves the server.
//
// Reuses the platform's storage mechanism (signed upload URLs against
// customer-uploads) but with its own image+video allowlist — the shared
// lib/uploadService is image-only.

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BUCKET = "customer-uploads";
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB — room for a short phone video

const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};
const VIDEO_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/3gpp": "3gp",
};

function sanitizeSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "x"
  );
}

type Body = { mime?: string; size?: number; groupingToken?: string };

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const mime = (body.mime ?? "").toLowerCase().trim();
  const isImage = mime in IMAGE_EXT;
  const isVideo = mime in VIDEO_EXT;
  if (!isImage && !isVideo) {
    return NextResponse.json(
      { ok: false, reason: "ชนิดไฟล์ไม่รองรับ — รองรับเฉพาะรูปภาพและวิดีโอ" },
      { status: 400 }
    );
  }
  if (
    typeof body.size === "number" &&
    Number.isFinite(body.size) &&
    body.size > MAX_BYTES
  ) {
    return NextResponse.json(
      { ok: false, reason: `ไฟล์ใหญ่เกิน ${MAX_BYTES / (1024 * 1024)} MB` },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "service role ยังไม่ได้ตั้งค่า — อัปโหลดปิดอยู่" },
      { status: 503 }
    );
  }

  const ext = isImage ? IMAGE_EXT[mime] : VIDEO_EXT[mime];
  // One folder per intake session so a draft's media cluster together.
  const folder = sanitizeSegment(body.groupingToken ?? "");
  const path = `intake-drafts/${
    folder === "x" ? crypto.randomUUID() : folder
  }/${crypto.randomUUID()}.${ext}`;

  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    console.error("[mobile-intake/upload-url] sign failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason:
          error?.message ?? "ออก signed URL ไม่สำเร็จ — ตั้งค่า bucket แล้วหรือยัง?",
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    bucket: BUCKET,
    path: data.path ?? path,
    token: data.token,
    mediaType: isImage ? "image" : "video",
    maxBytes: MAX_BYTES,
  });
}
