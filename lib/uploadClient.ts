// Browser-side upload helper for the customer / quote / order media
// pipeline. Pairs with lib/uploadService.ts (server-side signed-URL
// minting) so the client can:
//
//   1. Compress / re-encode a chosen image to JPEG before upload.
//   2. Ask our API for a signed PUT URL.
//   3. PUT the bytes to Storage with progress events + retry on
//      transient failures.
//
// Why client-side compression: the average phone camera shot is
// 4–8 MB. Compressing to ~1 MB JPEG cuts upload time on a 3G/4G
// connection by 5–10× and avoids hitting the 8 MB declared-size cap.
// Native HEIC/HEIF inputs are *passed through unchanged* — Canvas
// can't decode HEIC in most browsers; the server still accepts the
// raw file and a future Storage trigger will normalise it.
//
// Browser-only. Do NOT import from a server route or Node script —
// the FileReader / Canvas / XHR APIs are not present in Node.

export type UploadClientScope =
  | { scope: "quote"; branchCode?: string; groupingToken?: string }
  | { scope: "customer" }
  | { scope: "order"; orderId: string };

export type UploadProgress = {
  bytesSent: number;
  bytesTotal: number;
  percent: number;
};

export type UploadResult =
  | {
      ok: true;
      path: string;
      mime: string;
      sizeBytes: number;
      compressed: boolean;
      /** True when the server still needs to transcode this object
       *  (e.g. an Android upload of HEIC bytes that the client couldn't
       *  decode). A future Storage trigger picks these up. */
      needsTranscoding: boolean;
      /** Whether EXIF orientation was applied on the client. */
      orientationFixed: boolean;
    }
  | { ok: false; reason: string };

const TARGET_MAX_DIMENSION = 1920;
const TARGET_JPEG_QUALITY = 0.82;
// GIF stays as-is (re-encode loses animation). HEIC/HEIF are tried via
// `createImageBitmap` (which Safari iOS supports natively); when the
// decode fails, we pass the raw bytes through and the server-side
// transcoder picks it up. See COMPRESSION below.
const FORCE_PASSTHROUGH_MIMES = new Set(["image/gif"]);
const HEIC_MIMES = new Set(["image/heic", "image/heif"]);
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 600;

// ---------- Compression --------------------------------------------------

/**
 * Re-encode an image to JPEG, capped at TARGET_MAX_DIMENSION on the
 * longer side. Browsers without OffscreenCanvas fall through to the
 * regular <canvas> path. HEIC/HEIF and GIF are returned unchanged
 * (Canvas can't decode them or would lose animation).
 *
 * Returns the original blob if compression fails for any reason — the
 * upload should still proceed.
 */
export async function compressImageIfBeneficial(file: File): Promise<{
  blob: Blob;
  mime: string;
  compressed: boolean;
  /** True when the upload contains raw HEIC bytes a Storage trigger
   *  still needs to transcode. The caller forwards this hint to the
   *  /api/portal/upload-url endpoint as `needsTranscoding`. */
  needsTranscoding: boolean;
  /** Whether EXIF orientation was applied during re-encode. */
  orientationFixed: boolean;
}> {
  const mime = (file.type ?? "").toLowerCase();
  if (!mime.startsWith("image/")) {
    return {
      blob: file,
      mime: mime || "application/octet-stream",
      compressed: false,
      needsTranscoding: false,
      orientationFixed: false,
    };
  }
  if (FORCE_PASSTHROUGH_MIMES.has(mime)) {
    return {
      blob: file,
      mime,
      compressed: false,
      needsTranscoding: false,
      orientationFixed: false,
    };
  }

  // Attempt to decode + auto-apply EXIF orientation. `imageOrientation:
  // 'from-image'` is the standard option; older browsers ignore it and
  // we fall back to "no rotation" — which matches what pre-EXIF iOS
  // upload gave anyway.
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  }).catch(() => null);

  if (!bitmap) {
    // Decode failed. For HEIC/HEIF this is the expected path on Chrome/
    // Android — we upload the raw bytes and flag for server transcode.
    return {
      blob: file,
      mime,
      compressed: false,
      needsTranscoding: HEIC_MIMES.has(mime),
      orientationFixed: false,
    };
  }

  try {
    const { width, height } = bitmap;
    const longer = Math.max(width, height);

    // For HEIC we ALWAYS re-encode (output JPEG so older browsers can
    // render). For other images we re-encode only when it helps —
    // either to downscale or to apply EXIF orientation.
    const scale = longer > TARGET_MAX_DIMENSION ? TARGET_MAX_DIMENSION / longer : 1;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);

    // Skip re-encode for already-small non-HEIC images. The browser's
    // auto-orientation works at render time so we can safely ship the
    // original bytes for tiny screenshots etc.
    if (
      scale === 1 &&
      file.size < 1.2 * 1024 * 1024 &&
      !HEIC_MIMES.has(mime)
    ) {
      bitmap.close?.();
      return {
        blob: file,
        mime,
        compressed: false,
        needsTranscoding: false,
        orientationFixed: false,
      };
    }

    let canvas: HTMLCanvasElement | OffscreenCanvas;
    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(w, h);
    } else {
      canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) {
      bitmap.close?.();
      return {
        blob: file,
        mime,
        compressed: false,
        needsTranscoding: HEIC_MIMES.has(mime),
        orientationFixed: false,
      };
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob: Blob | null = await new Promise((resolve) => {
      if (canvas instanceof OffscreenCanvas) {
        canvas
          .convertToBlob({ type: "image/jpeg", quality: TARGET_JPEG_QUALITY })
          .then(resolve)
          .catch(() => resolve(null));
      } else {
        canvas.toBlob(
          (b) => resolve(b),
          "image/jpeg",
          TARGET_JPEG_QUALITY
        );
      }
    });
    if (!blob) {
      return {
        blob: file,
        mime,
        compressed: false,
        needsTranscoding: HEIC_MIMES.has(mime),
        orientationFixed: false,
      };
    }

    // If the "compressed" output is larger than the original AND the
    // input wasn't HEIC, keep the original. For HEIC we always prefer
    // the JPEG output even if larger — older browsers can't render
    // HEIC, so universal compatibility beats byte count.
    if (blob.size >= file.size && !HEIC_MIMES.has(mime)) {
      return {
        blob: file,
        mime,
        compressed: false,
        needsTranscoding: false,
        orientationFixed: false,
      };
    }
    return {
      blob,
      mime: "image/jpeg",
      compressed: true,
      needsTranscoding: false,
      orientationFixed: true,
    };
  } catch {
    return {
      blob: file,
      mime,
      compressed: false,
      needsTranscoding: HEIC_MIMES.has(mime),
      orientationFixed: false,
    };
  }
}

// ---------- Signed URL retrieval -----------------------------------------

async function fetchSignedUrl(
  scope: UploadClientScope,
  mime: string,
  size: number
): Promise<
  | { ok: true; signedUrl: string; path: string; token: string; maxBytes: number }
  | { ok: false; reason: string }
> {
  const isAnonymous = scope.scope === "quote";
  const endpoint = isAnonymous
    ? "/api/public/upload-url"
    : "/api/portal/upload-url";

  const body: Record<string, unknown> = { mime, size };
  if (scope.scope === "quote") {
    if (scope.branchCode) body.branchCode = scope.branchCode;
    if (scope.groupingToken) body.groupingToken = scope.groupingToken;
  } else if (scope.scope === "order") {
    body.scope = "order";
    body.orderId = scope.orderId;
  } else if (scope.scope === "customer") {
    body.scope = "customer";
  }

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      reason?: string;
      signedUrl?: string;
      path?: string;
      token?: string;
      maxBytes?: number;
    };
    if (!res.ok || !json.ok || !json.signedUrl || !json.path) {
      return {
        ok: false,
        reason: json.reason ?? `signed URL ล้มเหลว (HTTP ${res.status})`,
      };
    }
    return {
      ok: true,
      signedUrl: json.signedUrl,
      path: json.path,
      token: json.token ?? "",
      maxBytes: json.maxBytes ?? 8 * 1024 * 1024,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Network error",
    };
  }
}

// ---------- The PUT with progress + retry --------------------------------

function putWithProgress(
  url: string,
  blob: Blob,
  mime: string,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal
): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", mime);
    xhr.upload.onprogress = (e) => {
      if (!onProgress || !e.lengthComputable) return;
      onProgress({
        bytesSent: e.loaded,
        bytesTotal: e.total,
        percent: Math.round((e.loaded / e.total) * 100),
      });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          status: xhr.status,
          reason: xhr.responseText || `PUT ${xhr.status}`,
        });
      }
    };
    xhr.onerror = () =>
      resolve({ ok: false, status: 0, reason: "เครือข่ายขัดข้อง" });
    xhr.onabort = () =>
      resolve({ ok: false, status: 0, reason: "ผู้ใช้ยกเลิก" });
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
      } else {
        signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }
    }
    xhr.send(blob);
  });
}

function backoffMs(attempt: number): number {
  // attempt=1 → 600ms, 2 → 1800ms, 3 → 5400ms
  return RETRY_BASE_DELAY_MS * Math.pow(3, attempt - 1);
}

// ---------- Public entry point -------------------------------------------

/**
 * End-to-end upload: compress (if beneficial), fetch a signed URL,
 * PUT with progress, retry transient failures.
 *
 * Status codes treated as retryable: 0 (network), 408 (timeout),
 * 429 (rate-limit), 500/502/503/504 (server transient). Anything else
 * (e.g. 400 from MIME mismatch, 403 from expired URL) is final — we
 * surface the reason and bail.
 */
export async function uploadFile(input: {
  file: File;
  scope: UploadClientScope;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<UploadResult> {
  const { file, scope, onProgress, signal } = input;

  if (!file || file.size === 0) {
    return { ok: false, reason: "ไฟล์ว่างเปล่า" };
  }

  const {
    blob,
    mime,
    compressed,
    needsTranscoding,
    orientationFixed,
  } = await compressImageIfBeneficial(file);
  const sizeBytes = blob.size;

  let lastReason = "Unknown";
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      return { ok: false, reason: "ผู้ใช้ยกเลิก" };
    }
    const signed = await fetchSignedUrl(scope, mime, sizeBytes);
    if (!signed.ok) {
      lastReason = signed.reason;
      // Signed URL endpoint failed — usually a rate-limit (429) or
      // auth issue. Retry once for 429; otherwise bail.
      if (attempt < RETRY_MAX_ATTEMPTS && /429|timeout|network/i.test(signed.reason)) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return { ok: false, reason: signed.reason };
    }

    const put = await putWithProgress(
      signed.signedUrl,
      blob,
      mime,
      onProgress,
      signal
    );
    if (put.ok) {
      return {
        ok: true,
        path: signed.path,
        mime,
        sizeBytes,
        compressed,
        needsTranscoding,
        orientationFixed,
      };
    }

    lastReason = put.reason;
    const isRetryable =
      put.status === 0 ||
      put.status === 408 ||
      put.status === 429 ||
      put.status >= 500;
    if (!isRetryable || attempt === RETRY_MAX_ATTEMPTS) {
      return { ok: false, reason: put.reason };
    }
    await sleep(backoffMs(attempt));
  }

  return { ok: false, reason: lastReason };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const UPLOAD_CLIENT_RETRY_MAX = RETRY_MAX_ATTEMPTS;
export const UPLOAD_CLIENT_TARGET_DIMENSION = TARGET_MAX_DIMENSION;
