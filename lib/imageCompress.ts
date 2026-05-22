// Client-side image compression for public quote uploads.
//
// Phase 27B / W3.9. Shrinks a customer's photo before upload so a 6 MB
// phone snapshot becomes a ~300 KB–1.5 MB JPEG — faster uploads, less
// storage, no quality the human eye notices for a repair photo.
//
// Mobile reliability (W3.9):
//   • Every async step is bounded by a timeout. createImageBitmap and
//     canvas.toBlob can hang indefinitely on mobile Safari / the LINE
//     in-app browser; without a timeout the upload card would stick at
//     "กำลังย่อรูป" forever. On timeout we fall back to the original.
//   • HEIC: we now ATTEMPT a canvas decode (Safari can render HEIC in
//     <img>), producing a JPEG. If decode fails (e.g. LINE in-app
//     browser can't), the original HEIC is returned UNCHANGED and the
//     caller detects the still-HEIC type to warn the user.
//   • MAX_DIMENSION lowered to 1280 — smaller canvas = less memory =
//     fewer low-end-device crashes, smaller upload on slow networks.
//
// Browser-only — uses Image + canvas + URL.createObjectURL.

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.8;
const DECODE_TIMEOUT_MS = 10000;
const ENCODE_TIMEOUT_MS = 6000;

export function isHeicFile(file: File): boolean {
  const t = file.type.toLowerCase();
  const n = file.name.toLowerCase();
  return (
    t.includes("heic") ||
    t.includes("heif") ||
    n.endsWith(".heic") ||
    n.endsWith(".heif")
  );
}

export function isHeicType(mime: string): boolean {
  const t = (mime ?? "").toLowerCase();
  return t.includes("heic") || t.includes("heif");
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_timeout`)), ms)
    ),
  ]);
}

/**
 * Compress an image File. Returns a new JPEG File when decode+encode
 * succeed, or the ORIGINAL file when they can't (HEIC on a browser that
 * can't decode it, decode/encode failure, decode/encode timeout, or the
 * JPEG wasn't smaller). Never throws, never hangs.
 *
 * The caller should inspect the returned File's `type`: if it's still
 * a HEIC/HEIF type, conversion failed and the file likely won't upload
 * cleanly on older devices.
 */
export async function compressImage(file: File): Promise<File> {
  const looksImage = file.type.startsWith("image/") || isHeicFile(file);
  if (!looksImage) {
    return file;
  }
  try {
    const bitmap = await withTimeout(loadBitmap(file), DECODE_TIMEOUT_MS, "decode");
    const { width, height } = scaled(bitmap.width, bitmap.height);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    if ("close" in bitmap && typeof bitmap.close === "function") {
      bitmap.close();
    }

    const blob = await withTimeout(
      new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY);
      }),
      ENCODE_TIMEOUT_MS,
      "encode"
    );
    if (!blob) return file;

    // For non-HEIC: only keep the JPEG if it's actually smaller.
    // For HEIC: always keep the JPEG — the original HEIC may not upload
    // on older devices, so a slightly-larger JPEG is the safer choice.
    const wasHeic = isHeicFile(file);
    if (!wasHeic && blob.size >= file.size) {
      return file;
    }
    const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], newName, { type: "image/jpeg" });
  } catch {
    // Decode/encode failed or timed out — hand back the original so the
    // caller can decide (size check / HEIC warning / attempt upload).
    return file;
  }
}

function scaled(
  w: number,
  h: number
): { width: number; height: number } {
  if (w <= MAX_DIMENSION && h <= MAX_DIMENSION) return { width: w, height: h };
  const ratio = Math.min(MAX_DIMENSION / w, MAX_DIMENSION / h);
  return {
    width: Math.round(w * ratio),
    height: Math.round(h * ratio),
  };
}

async function loadBitmap(
  file: File
): Promise<ImageBitmap | HTMLImageElement> {
  // Prefer createImageBitmap — faster + off-main-thread decode. Some
  // mobile browsers reject or hang on it; the outer withTimeout + the
  // <img> fallback cover both.
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // fall through to <img>
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode_failed"));
    };
    img.src = url;
  });
}
