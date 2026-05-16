"use client";

// <OrderItemImages> — per-item repair photos for OPS.
//
// Store Ops Hardening. Captures + shows the photos on one repair item
// (damage reference, before/after). Used in two places:
//   • IntakeOrderForm item cards — capture at drop-off (orderId absent;
//     a grouping token clusters the uploads).
//   • OrderDetailModal item rows — view saved photos + add more after
//     the repair (real orderId).
//
// Reuses the existing pipeline: lib/imageCompress + the signed-URL
// upload/read routes (/api/admin/upload-url, /api/admin/order-images).
// Storage paths are the value — the parent persists them onto
// order_items.image_paths. Mobile/tablet-first: the file input opens
// the device camera/gallery; thumbnails tap to a full-screen preview.

import { useCallback, useEffect, useRef, useState } from "react";
import supabase from "@/lib/supabase";
import { compressImage } from "@/lib/imageCompress";

const MAX_FILES = 6;
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

type Pending = {
  id: string;
  status: "uploading" | "error";
  previewUrl: string;
  error: string | null;
};

function accepted(file: File): string | null {
  const t = file.type.toLowerCase();
  const n = file.name.toLowerCase();
  if (!(ALLOWED.includes(t) || n.endsWith(".heic") || n.endsWith(".heif")))
    return "ชนิดไฟล์ไม่รองรับ";
  if (file.size > MAX_BYTES) return "ไฟล์ใหญ่เกิน 8 MB";
  return null;
}

export function OrderItemImages({
  value,
  onChange,
  branchCode,
  orderId,
  readOnly = false,
}: {
  /** Saved storage paths (order_items.image_paths). */
  value: string[];
  /** Emits the updated path list. */
  onChange: (paths: string[]) => void;
  branchCode: string | null;
  /** Real order id once it exists; absent at intake. */
  orderId?: string | null;
  /** When true, no upload control — view only. */
  readOnly?: boolean;
}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);
  const groupingToken = useRef(
    `oi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Resolve signed read URLs for saved paths we have not seen yet.
  useEffect(() => {
    const missing = value.filter((p) => !(p in resolved));
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/order-images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: missing }),
        });
        const json = (await res.json()) as { urls?: Record<string, string> };
        if (!cancelled && json.urls) {
          setResolved((prev) => ({ ...prev, ...json.urls }));
        }
      } catch {
        // Leave unresolved — the thumbnail shows a neutral placeholder.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [value, resolved]);

  const uploadOne = useCallback(
    async (file: File): Promise<{ path: string | null; error: string | null }> => {
      try {
        const compressed = await compressImage(file);
        const res = await fetch("/api/admin/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mime: compressed.type || "image/jpeg",
            size: compressed.size,
            branchCode: branchCode || null,
            orderId: orderId || null,
            groupingToken: groupingToken.current,
          }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          reason?: string;
          bucket?: string;
          path?: string;
          token?: string;
        };
        if (!res.ok || !json.ok || !json.bucket || !json.path || !json.token) {
          return { path: null, error: json.reason ?? "ขอ URL อัปโหลดไม่สำเร็จ" };
        }
        const up = await supabase.storage
          .from(json.bucket)
          .uploadToSignedUrl(json.path, json.token, compressed);
        if (up.error) return { path: null, error: up.error.message };
        return { path: json.path, error: null };
      } catch (err) {
        return {
          path: null,
          error: err instanceof Error ? err.message : "อัปโหลดล้มเหลว",
        };
      }
    },
    [branchCode, orderId]
  );

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files) return;
      const room = MAX_FILES - value.length;
      const picked = Array.from(files).slice(0, Math.max(0, room));
      let acc = [...value];
      // Sequential — keeps `acc` correct without an append race.
      for (const file of picked) {
        const reason = accepted(file);
        const previewUrl = URL.createObjectURL(file);
        const id = `${file.name}-${Math.random().toString(36).slice(2, 7)}`;
        if (reason) {
          setPending((p) => [
            ...p,
            { id, status: "error", previewUrl, error: reason },
          ]);
          continue;
        }
        setPending((p) => [
          ...p,
          { id, status: "uploading", previewUrl, error: null },
        ]);
        const { path, error } = await uploadOne(file);
        if (error || !path) {
          setPending((p) =>
            p.map((x) =>
              x.id === id ? { ...x, status: "error", error } : x
            )
          );
        } else {
          acc = [...acc, path];
          onChange(acc);
          setPending((p) => p.filter((x) => x.id !== id));
        }
      }
      if (inputRef.current) inputRef.current.value = "";
    },
    [value, uploadOne, onChange]
  );

  const remove = (path: string) => onChange(value.filter((p) => p !== path));

  const total = value.length + pending.length;

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {value.map((path) => (
          <button
            type="button"
            key={path}
            onClick={() => resolved[path] && setLightbox(resolved[path])}
            className="relative h-16 w-16 overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
          >
            {resolved[path] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={resolved[path]}
                alt="repair photo"
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[10px] text-gray-400">
                …
              </span>
            )}
            {!readOnly && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(path);
                }}
                className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-[9px] text-white"
              >
                ✕
              </span>
            )}
          </button>
        ))}
        {pending.map((p) => (
          <div
            key={p.id}
            className="relative h-16 w-16 overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.previewUrl}
              alt="uploading"
              className="h-full w-full object-cover opacity-60"
            />
            <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-center text-[8px] text-white">
              {p.status === "uploading" ? "อัปโหลด..." : p.error ?? "ผิดพลาด"}
            </span>
          </div>
        ))}
      </div>

      {!readOnly && total < MAX_FILES && (
        <label className="mt-2 inline-block cursor-pointer rounded-lg border border-dashed border-green-400 px-3 py-1.5 text-xs font-semibold text-green-700 hover:bg-green-50">
          + เพิ่มรูป
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => void handleFiles(e.target.files)}
            className="hidden"
          />
        </label>
      )}

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox}
            alt="repair photo"
            className="max-h-full max-w-full rounded-lg"
          />
        </div>
      )}
    </div>
  );
}

export default OrderItemImages;
