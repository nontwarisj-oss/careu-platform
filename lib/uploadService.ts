// Customer / quote upload pipeline. Issues signed UPLOAD URLs against a
// private Supabase Storage bucket so customers can PUT files directly to
// storage without the platform proxying the bytes.
//
// Architecture:
//   1. Client requests a signed URL from /api/{portal,public}/upload-url
//      with the file's mime + (claimed) size.
//   2. Route handler authorises the request (portal session, or anon
//      rate-limit), then calls into this module to mint a signed URL
//      against the customer-uploads bucket.
//   3. Client PUTs the bytes to the signed URL. Storage validates the
//      payload against the URL's constraints (path, expiry).
//   4. Client posts the resulting `path` back to the platform (e.g.
//      saved on `quote_requests.photos`).
//
// Foundation phase contract:
//   • Allowed MIME types: image/jpeg, image/png, image/webp, image/heic.
//   • Max declared size: 8 MB per file. Storage's own per-bucket cap
//     overrides at the actual upload time.
//   • Signed URL TTL: 5 minutes.
//   • Folder layout:
//        <branch_code>/quotes/<quote_request_id-or-pending>/<uuid>.<ext>
//        <branch_code>/customers/<customer_id>/<uuid>.<ext>
//        <branch_code>/orders/<order_id>/<uuid>.<ext>
//   • Anon callers may only target the `quotes/...` prefix.
//
// Future: image compression / re-encoding via a Storage trigger or an
// inline edge function. The signed-URL path stays the same.

import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const BUCKET = "customer-uploads";
const SIGNED_URL_TTL_SECONDS = 5 * 60;
const MAX_DECLARED_SIZE_BYTES = 8 * 1024 * 1024;
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

export type UploadScope =
  | { scope: "quote"; branchCode: string; quoteRequestId?: string | null }
  | { scope: "customer"; branchCode: string; customerId: string }
  | { scope: "order"; branchCode: string; orderId: string };

export type IssueUploadUrlResult =
  | {
      ok: true;
      bucket: string;
      /** Object path inside the bucket; what the client PUTs the bytes to
       *  and what the platform stores as a reference. */
      path: string;
      /** Pre-signed PUT URL the client uploads to. Expires shortly. */
      signedUrl: string;
      /** Token the client must include — Supabase's createSignedUploadUrl
       *  bakes it into `signedUrl`, but we surface it separately for
       *  callers that bypass the URL builder. */
      token: string;
      mime: string;
      maxBytes: number;
      expiresAt: string;
    }
  | { ok: false; reason: string };

function sanitiseSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "x";
}

function buildPath(scope: UploadScope, mime: string): string {
  const ext = MIME_EXT[mime] ?? "bin";
  const file = `${crypto.randomUUID()}.${ext}`;
  const branch = sanitiseSegment(scope.branchCode);
  switch (scope.scope) {
    case "quote": {
      const qid = scope.quoteRequestId
        ? sanitiseSegment(scope.quoteRequestId)
        : "pending";
      return `${branch}/quotes/${qid}/${file}`;
    }
    case "customer":
      return `${branch}/customers/${sanitiseSegment(scope.customerId)}/${file}`;
    case "order":
      return `${branch}/orders/${sanitiseSegment(scope.orderId)}/${file}`;
  }
}

/**
 * Issue a signed UPLOAD URL. Validates mime + size declaration; the
 * actual byte-level enforcement happens at storage.objects level when
 * the customer PUTs the file.
 */
export async function issueUploadUrl(input: {
  scope: UploadScope;
  mime: string;
  declaredSize?: number | null;
}): Promise<IssueUploadUrlResult> {
  const mime = (input.mime ?? "").toLowerCase().trim();
  if (!ALLOWED_MIME.has(mime)) {
    return {
      ok: false,
      reason: `MIME ไม่รองรับ — รองรับเฉพาะ ${Array.from(ALLOWED_MIME).join(", ")}`,
    };
  }
  if (
    input.declaredSize !== undefined &&
    input.declaredSize !== null &&
    input.declaredSize > MAX_DECLARED_SIZE_BYTES
  ) {
    return {
      ok: false,
      reason: `ไฟล์ใหญ่เกินขีดจำกัด ${MAX_DECLARED_SIZE_BYTES / (1024 * 1024)} MB`,
    };
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      ok: false,
      reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า — uploads ปิดอยู่",
    };
  }

  const path = buildPath(input.scope, mime);
  // Phase W3.1 diagnostic — confirm the server-side mint actually
  // succeeds in production. Logs go to Vercel function logs only; no
  // secrets are emitted (signedUrl/token are NOT logged).
  const mintStart = Date.now();
  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);
  const mintMs = Date.now() - mintStart;
  if (error || !data) {
    console.warn("[upload-url] createSignedUploadUrl FAILED", {
      bucket: BUCKET,
      path,
      mime,
      mintMs,
      error: error?.message ?? "no data returned",
    });
    return {
      ok: false,
      reason: error?.message ?? "ออก signed URL ไม่สำเร็จ — bucket ตั้งค่าแล้วหรือยัง?",
    };
  }
  console.log("[upload-url] createSignedUploadUrl ok", {
    bucket: BUCKET,
    path,
    mime,
    mintMs,
    hasToken: Boolean(data.token),
  });
  return {
    ok: true,
    bucket: BUCKET,
    path: data.path ?? path,
    signedUrl: data.signedUrl,
    token: data.token,
    mime,
    maxBytes: MAX_DECLARED_SIZE_BYTES,
    expiresAt: new Date(
      Date.now() + SIGNED_URL_TTL_SECONDS * 1000
    ).toISOString(),
  };
}

/**
 * Issue a short-lived signed READ URL for an existing object. Used by
 * the portal receipt viewer to render attached photos. Returns null
 * on error so callers can fall through to "photo unavailable".
 */
export async function issueReadUrl(
  path: string,
  ttlSeconds = 60
): Promise<string | null> {
  if (!path) return null;
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, ttlSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}

export const UPLOAD_BUCKET = BUCKET;
export const UPLOAD_MAX_BYTES = MAX_DECLARED_SIZE_BYTES;
export const UPLOAD_ALLOWED_MIME = Array.from(ALLOWED_MIME);
