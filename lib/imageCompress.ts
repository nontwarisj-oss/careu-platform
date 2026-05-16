// Client-side image compression for public quote uploads.
//
// Phase 27B. Shrinks a customer's photo before upload so a 6 MB
// phone snapshot becomes a ~300 KB JPEG — faster uploads, less
// storage, no quality the human eye notices for a repair photo.
//
// HEIC: browsers cannot decode HEIC into a <canvas>, so a HEIC file
// is passed through UNCHANGED (the size cap still applies upstream).
// Everything else is drawn to a canvas + re-encoded as JPEG.
//
// Browser-only — uses Image + canvas + URL.createObjectURL.

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;

function isHeic(file: File): boolean {
  const t = file.type.toLowerCase();
  const n = file.name.toLowerCase();
  return (
    t.includes("heic") ||
    t.includes("heif") ||
    n.endsWith(".heic") ||
    n.endsWith(".heif")
  );
}

/**
 * Compress an image File. Returns a new File (JPEG) when compression
 * succeeded, or the ORIGINAL file when it couldn't (HEIC, decode
 * failure, or the result wasn't smaller). Never throws.
 */
export async function compressImage(file: File): Promise<File> {
  if (isHeic(file) || !file.type.startsWith("image/")) {
    return file;
  }
  try {
    const bitmap = await loadBitmap(file);
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

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY);
    });
    if (!blob || blob.size >= file.size) {
      // Compression didn't help (already small / already optimal).
      return file;
    }
    const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], newName, { type: "image/jpeg" });
  } catch {
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
  // Prefer createImageBitmap — faster + off-main-thread decode.
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
      reject(new Error("decode failed"));
    };
    img.src = url;
  });
}
