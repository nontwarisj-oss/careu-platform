// HEIC/HEIF → JPEG transcoder.
//
// Reads bytes from Supabase Storage at `sourcePath`, decodes the HEIC
// payload via sharp (libheif build), normalises EXIF orientation,
// re-encodes to JPEG at quality 0.82, and writes a sibling object at
// `<sourcePath>.jpg`. Also produces a small thumbnail at
// `<sourcePath>.thumb.jpg` so list views can render fast without
// downloading the full image.
//
// Why sharp:
//   • Native — no V8 image work, no canvas. Decoding HEIC takes ~30–80
//     ms on a typical Vercel function.
//   • Preserves EXIF orientation by default via `.rotate()` with no
//     argument.
//   • Strips PII metadata (EXIF GPS / camera serial) when we don't
//     copy it forward — good for customer privacy.
//
// libheif availability:
//   • Sharp's official prebuilt binaries support HEIF on Linux x64 +
//     macOS + Linux ARM. Windows prebuilt does NOT include libheif —
//     a Windows dev machine will see `decode failed: HEIF not built`.
//     That's fine — production is Linux on Vercel.
//   • We catch the "HEIF not built" error and surface it cleanly to
//     the cron processor so the row stays in 'pending' with a known
//     reason rather than dead-lettering on a dev machine.
//
// Server-only. Never import this from a "use client" file.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const BUCKET = "customer-uploads";
const TARGET_QUALITY = 82;
const THUMBNAIL_MAX_DIMENSION = 320;

export type TranscodeResult =
  | { ok: true; outputPath: string; thumbnailPath: string | null; sizeBytes: number }
  | { ok: false; reason: string; retryable: boolean };

/**
 * Drives the per-row HEIC transcode. Called by the cron worker for
 * each pending row in media_transcode_queue.
 *
 * Return contract:
 *   • ok=true → writes output_path back on the queue row.
 *   • retryable=true → cron leaves the row in 'pending' for the next
 *     tick.
 *   • retryable=false → cron dead-letters after MAX_ATTEMPTS.
 */
export async function transcodeHeicToJpeg(args: {
  sourcePath: string;
}): Promise<TranscodeResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      ok: false,
      reason: "SERVICE_ROLE_KEY not set — cannot read source bytes",
      retryable: true,
    };
  }

  // Sharp is dynamically imported so the cron route compiles even on
  // platforms where the binary isn't available. The import failing is
  // an honest "transcoder not available" — retryable so an operator
  // who rebuilds the deploy doesn't lose the queue.
  let sharp: typeof import("sharp");
  try {
    const mod = await import("sharp");
    // Newer sharp ships as ESM with default export; older as CJS
    // where the function IS the module. Handle both.
    sharp = ((mod as unknown as { default?: typeof import("sharp") }).default ??
      (mod as unknown as typeof import("sharp")));
  } catch (err) {
    return {
      ok: false,
      reason: `sharp not available: ${
        err instanceof Error ? err.message : String(err)
      }`,
      retryable: true,
    };
  }

  // Download the source bytes via the service-role storage client.
  const download = await admin.storage.from(BUCKET).download(args.sourcePath);
  if (download.error || !download.data) {
    return {
      ok: false,
      reason: download.error?.message ?? "source download failed",
      retryable: true,
    };
  }
  const arrayBuf = await download.data.arrayBuffer();
  const sourceBuffer = Buffer.from(arrayBuf);

  // Decode + normalise + re-encode. .rotate() (no arg) applies EXIF
  // orientation and removes the EXIF tag so downstream viewers don't
  // double-apply it.
  let outputBuffer: Buffer;
  let thumbBuffer: Buffer | null = null;
  try {
    const baseImage = sharp(sourceBuffer, { failOn: "truncated" });
    outputBuffer = await baseImage
      .clone()
      .rotate()
      .jpeg({ quality: TARGET_QUALITY, mozjpeg: true })
      .toBuffer();
    try {
      thumbBuffer = await baseImage
        .clone()
        .rotate()
        .resize({
          width: THUMBNAIL_MAX_DIMENSION,
          height: THUMBNAIL_MAX_DIMENSION,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 70, mozjpeg: true })
        .toBuffer();
    } catch (err) {
      // Thumbnail failures shouldn't kill the main transcode — log
      // the reason and continue.
      console.warn(
        "[heic-transcode] thumbnail generation failed",
        err instanceof Error ? err.message : String(err)
      );
      thumbBuffer = null;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // libheif missing is the most common dev-environment case. The
    // operator on Windows sees this and knows production-on-Linux
    // will succeed.
    const isLibheifMissing = /heif|libheif|format/i.test(reason);
    return {
      ok: false,
      reason: isLibheifMissing
        ? `HEIF decode unavailable: ${reason}`
        : reason,
      // The "HEIF not built" case is operationally retryable — a
      // redeploy with the libheif build fixes it without us needing
      // to dead-letter the queue. Real corruption errors (truncated,
      // not-an-image) are NOT retryable.
      retryable: isLibheifMissing || /truncat|incomplete/i.test(reason),
    };
  }

  // Write outputs to sibling paths. Convention: source `<path>.heic`
  // becomes `<path>.heic.jpg` and `<path>.heic.thumb.jpg`. Storing
  // alongside the original (rather than a separate /transcoded folder)
  // keeps the branch-scoped storage structure intact.
  const outputPath = `${args.sourcePath}.jpg`;
  const thumbnailPath = thumbBuffer ? `${args.sourcePath}.thumb.jpg` : null;

  const uploadJpg = await admin.storage
    .from(BUCKET)
    .upload(outputPath, outputBuffer, {
      contentType: "image/jpeg",
      upsert: true,
    });
  if (uploadJpg.error) {
    return {
      ok: false,
      reason: `JPEG upload failed: ${uploadJpg.error.message}`,
      retryable: true,
    };
  }
  if (thumbBuffer && thumbnailPath) {
    const uploadThumb = await admin.storage
      .from(BUCKET)
      .upload(thumbnailPath, thumbBuffer, {
        contentType: "image/jpeg",
        upsert: true,
      });
    if (uploadThumb.error) {
      // Thumbnail upload failure is non-fatal — the main JPEG is up.
      console.warn(
        "[heic-transcode] thumbnail upload failed",
        uploadThumb.error.message
      );
    }
  }

  return {
    ok: true,
    outputPath,
    thumbnailPath,
    sizeBytes: outputBuffer.length,
  };
}
