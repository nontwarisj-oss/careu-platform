// POST /api/public/upload — Phase W3.3 server-side upload.
//
// Replaces the browser signed-URL PUT flow for /quote photos. The
// customer's browser POSTs a multipart/form-data body here; this
// route then uploads the bytes to Supabase Storage using the
// service-role key. The browser never talks to the Storage host
// directly, so CORS / signed-URL token / bucket-policy issues are
// out of the picture entirely.
//
// Response shape (success): { ok: true, bucket, path }
// Response shape (error)  : { ok: false, reason: "<Thai>" }
//
// Security:
//   • Rate limit: 20 uploads / hour / IP.
//   • MIME whitelist: image/jpeg|png|webp|heic|heif.
//   • Hard cap: 4 MB per file (intended for client-compressed input).
//   • branchCode validated against active branches; bad slug → "no-branch".
//   • Service-role key NEVER leaves the server — only path + bucket
//     returned. No signed URL, no token.
//   • Bucket stays private; only authenticated admin routes mint
//     short-lived signed READ URLs for the queue.
//
// Note on Vercel body size:
//   Vercel's default function body limit is ~4.5 MB on Pro; the 4 MB
//   cap below keeps us safely inside that. On Hobby it's ~1 MB — if
//   you see HTTP 413 from Vercel (not from this handler), the project
//   needs a higher tier or further client-side compression.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const BUCKET = "customer-uploads";
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

function sanitiseSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "x"
  );
}

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "public-upload",
    limit: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason: "อัปโหลดบ่อยเกินไป — รออีกสักครู่แล้วลองใหม่",
      },
      { status: 429, headers: { "Retry-After": "3600" } }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        reason: "รูปแบบคำขอไม่ถูกต้อง (ต้อง multipart/form-data)",
      },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบไฟล์รูปในคำขอ" },
      { status: 400 }
    );
  }

  const mime = (file.type || "").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json(
      {
        ok: false,
        reason: `MIME ไม่รองรับ — รองรับเฉพาะ ${Array.from(ALLOWED_MIME).join(
          ", "
        )}`,
      },
      { status: 400 }
    );
  }

  if (file.size <= 0) {
    return NextResponse.json(
      { ok: false, reason: "ไฟล์ว่างเปล่า" },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        reason: `ไฟล์ใหญ่เกินขีดจำกัด ${MAX_BYTES / (1024 * 1024)} MB หลังบีบอัด`,
      },
      { status: 413 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      {
        ok: false,
        reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า — uploads ปิดอยู่",
      },
      { status: 503 }
    );
  }

  // Branch validation — keeps storage paths clean. Unknown / inactive
  // branches fold into "no-branch" so an attacker can't litter the
  // bucket with arbitrary folder names.
  const rawBranchCode = String(form.get("branchCode") ?? "").trim();
  let branchCode = rawBranchCode;
  if (branchCode) {
    const branchRes = await admin
      .from("branches")
      .select("code, is_active")
      .eq("code", branchCode)
      .maybeSingle();
    const row = branchRes.data as
      | { code: string; is_active: boolean }
      | null;
    if (!row || row.is_active === false) {
      branchCode = "no-branch";
    }
  } else {
    branchCode = "no-branch";
  }

  const rawGrouping = String(form.get("groupingToken") ?? "").trim();
  const groupingToken = rawGrouping || "pending";

  const branchSeg = sanitiseSegment(branchCode);
  const groupSeg = sanitiseSegment(groupingToken);
  const ext = MIME_EXT[mime] ?? "bin";
  const path = `${branchSeg}/quotes/${groupSeg}/${crypto.randomUUID()}.${ext}`;

  // Diagnostic — visible in Vercel function logs. No secrets, no token,
  // no signed URL (we don't generate one here).
  console.log("[public-upload] uploading", {
    bucket: BUCKET,
    path,
    mime,
    size: file.size,
  });

  const buffer = await file.arrayBuffer();
  const startMs = Date.now();
  const { error: uploadErr } = await admin.storage
    .from(BUCKET)
    .upload(path, buffer, {
      contentType: mime,
      upsert: false,
    });
  const elapsedMs = Date.now() - startMs;

  if (uploadErr) {
    console.warn("[public-upload] storage upload FAILED", {
      bucket: BUCKET,
      path,
      mime,
      size: file.size,
      elapsedMs,
      error: uploadErr.message,
    });
    return NextResponse.json(
      {
        ok: false,
        reason: `อัปโหลดไม่สำเร็จ: ${uploadErr.message}`,
      },
      { status: 500 }
    );
  }

  console.log("[public-upload] storage upload ok", {
    bucket: BUCKET,
    path,
    elapsedMs,
  });

  return NextResponse.json({
    ok: true,
    bucket: BUCKET,
    path,
  });
}
