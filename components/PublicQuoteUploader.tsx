"use client";

// <PublicQuoteUploader> — Phase 27B safe photo upload for the public
// quote wizard.
//
// Per file: type + size validation → client-side compression
// (lib/imageCompress) → signed upload URL (/api/public/upload-url) →
// direct PUT to Supabase Storage via uploadToSignedUrl. A queue with
// per-file status (queued / uploading / done / error) + retry. The
// uploaded storage PATHS are surfaced to the parent via onChange so
// the quote submission can carry them in `photos`.

import { useCallback, useEffect, useRef, useState } from "react";
import supabase from "@/lib/supabase";
import { compressImage } from "@/lib/imageCompress";

const MAX_FILES = 8;
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

type UploadItem = {
  id: string;
  name: string;
  status: "queued" | "uploading" | "done" | "error";
  /** Storage path once uploaded — what the quote submits. */
  path: string | null;
  error: string | null;
  /** Local preview object URL. */
  previewUrl: string;
  file: File;
};

function accepted(file: File): string | null {
  const t = file.type.toLowerCase();
  const n = file.name.toLowerCase();
  const okType =
    ALLOWED.includes(t) ||
    n.endsWith(".heic") ||
    n.endsWith(".heif");
  if (!okType) return "ชนิดไฟล์ไม่รองรับ (รองรับ JPG / PNG / WEBP / HEIC)";
  if (file.size > MAX_BYTES) return "ไฟล์ใหญ่เกิน 8 MB";
  return null;
}

export function PublicQuoteUploader({
  branchCode,
  onChange,
  onProgress,
}: {
  branchCode: string | null;
  /** Called with the list of successfully-uploaded storage paths. */
  onChange: (paths: string[]) => void;
  /** Fires whenever upload state changes. Lets the parent gate "Next" /
   *  submit while any file is queued or in-flight — otherwise the user
   *  can race ahead, unmount this component mid-PUT, and the resolved
   *  path is silently lost (Phase W3 bug fix). */
  onProgress?: (state: {
    uploading: boolean;
    done: number;
    total: number;
    errors: number;
  }) => void;
}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const groupingToken = useRef(
    `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Mirror items → onProgress so the parent can gate navigation. Runs
  // on every items mutation including mount; the parent treats
  // total === 0 as "nothing in flight" (no false positive).
  useEffect(() => {
    if (!onProgress) return;
    const uploading = items.some(
      (i) => i.status === "uploading" || i.status === "queued"
    );
    const done = items.filter((i) => i.status === "done").length;
    const errors = items.filter((i) => i.status === "error").length;
    onProgress({ uploading, done, total: items.length, errors });
  }, [items, onProgress]);

  const emit = useCallback(
    (list: UploadItem[]) => {
      onChange(
        list
          .filter((i) => i.status === "done" && i.path)
          .map((i) => i.path as string)
      );
    },
    [onChange]
  );

  const uploadOne = useCallback(
    async (item: UploadItem): Promise<{ path: string | null; error: string | null }> => {
      // Phase W3.1 — hard 45s budget. supabase-js's Storage client has
      // no built-in timeout, so a hung PUT (bucket missing, CORS, slow
      // network) would otherwise leave the card stuck at
      // "กำลังอัปโหลด..." forever. Promise.race guarantees uploadOne
      // resolves so the UI can flip to "error" + show the retry button.
      const HARD_TIMEOUT_MS = 45000;

      const doUpload = async (): Promise<{
        path: string | null;
        error: string | null;
      }> => {
        try {
          console.warn("[quote-upload] compress start", item.name, item.file.size, item.file.type);
          const compressed = await compressImage(item.file);
          console.warn("[quote-upload] compress ok", compressed.size, compressed.type);

          let res: Response;
          try {
            res = await fetch("/api/public/upload-url", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mime: compressed.type || "image/jpeg",
                size: compressed.size,
                branchCode: branchCode || null,
                groupingToken: groupingToken.current,
              }),
            });
          } catch (fetchErr) {
            const msg = fetchErr instanceof Error ? fetchErr.message : "ขอ URL อัปโหลดไม่สำเร็จ";
            console.warn("[quote-upload] sign URL fetch threw", fetchErr);
            return { path: null, error: `เชื่อมเซิร์ฟเวอร์ไม่ได้: ${msg}` };
          }

          let json: {
            ok?: boolean;
            reason?: string;
            bucket?: string;
            path?: string;
            token?: string;
          };
          try {
            json = await res.json();
          } catch (parseErr) {
            console.warn("[quote-upload] sign URL JSON parse failed", parseErr, "status", res.status);
            return {
              path: null,
              error: `ขอ URL อัปโหลดไม่สำเร็จ (HTTP ${res.status})`,
            };
          }
          console.warn("[quote-upload] sign URL response", res.status, json);

          if (!res.ok || !json.ok || !json.bucket || !json.path || !json.token) {
            return {
              path: null,
              error:
                json.reason ??
                `ขอ URL อัปโหลดไม่สำเร็จ (HTTP ${res.status})`,
            };
          }

          console.warn("[quote-upload] PUT to storage", json.bucket, json.path);
          const up = await supabase.storage
            .from(json.bucket)
            .uploadToSignedUrl(json.path, json.token, compressed);
          if (up.error) {
            console.warn("[quote-upload] storage error", up.error);
            return {
              path: null,
              error: `อัปโหลดไม่สำเร็จ: ${up.error.message ?? "Storage error"}`,
            };
          }
          console.warn("[quote-upload] PUT ok", json.path);
          return { path: json.path, error: null };
        } catch (err) {
          console.warn("[quote-upload] uploadOne exception", err);
          return {
            path: null,
            error: err instanceof Error ? err.message : "อัปโหลดล้มเหลว",
          };
        }
      };

      const timeoutPromise = new Promise<{
        path: null;
        error: string;
      }>((resolve) => {
        setTimeout(
          () =>
            resolve({
              path: null,
              error: `อัปโหลดเกินเวลา ${Math.round(
                HARD_TIMEOUT_MS / 1000
              )} วินาที — ลองใหม่หรือเลือกรูปอื่น`,
            }),
          HARD_TIMEOUT_MS
        );
      });

      return Promise.race([doUpload(), timeoutPromise]);
    },
    [branchCode]
  );

  const runUpload = useCallback(
    async (id: string) => {
      let snapshot: UploadItem[] = [];
      setItems((prev) => {
        snapshot = prev.map((i) =>
          i.id === id ? { ...i, status: "uploading", error: null } : i
        );
        return snapshot;
      });
      const target = snapshot.find((i) => i.id === id);
      if (!target) return;
      const { path, error } = await uploadOne(target);
      setItems((prev) => {
        const next = prev.map((i) =>
          i.id === id
            ? {
                ...i,
                status: (error ? "error" : "done") as UploadItem["status"],
                path,
                error,
              }
            : i
        );
        emit(next);
        return next;
      });
    },
    [uploadOne, emit]
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const room = MAX_FILES - items.length;
      const picked = Array.from(files).slice(0, Math.max(0, room));
      const fresh: UploadItem[] = picked.map((file) => {
        const reason = accepted(file);
        return {
          id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          status: reason ? "error" : "queued",
          path: null,
          error: reason,
          previewUrl: URL.createObjectURL(file),
          file,
        };
      });
      setItems((prev) => [...prev, ...fresh]);
      for (const it of fresh) {
        if (it.status === "queued") void runUpload(it.id);
      }
      if (inputRef.current) inputRef.current.value = "";
    },
    [items.length, runUpload]
  );

  const remove = useCallback(
    (id: string) => {
      setItems((prev) => {
        const next = prev.filter((i) => i.id !== id);
        emit(next);
        return next;
      });
    },
    [emit]
  );

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => handleFiles(e.target.files)}
        className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-green-700 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white"
      />
      <p className="text-[11px] text-gray-500">
        สูงสุด {MAX_FILES} รูป · ไฟล์ละไม่เกิน 8 MB · ระบบจะย่อรูปให้อัตโนมัติ
      </p>

      {items.length > 0 && (
        <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {items.map((it) => (
            <li
              key={it.id}
              className="relative aspect-square rounded-xl overflow-hidden border border-gray-200 bg-gray-100"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={it.previewUrl}
                alt={it.name}
                className="w-full h-full object-cover"
              />
              <div
                title={it.status === "error" ? it.error ?? "ผิดพลาด" : undefined}
                className="absolute inset-x-0 bottom-0 bg-black/55 px-1.5 py-1 text-[9px] leading-tight text-white text-center break-words"
              >
                {it.status === "uploading" && "กำลังอัปโหลด..."}
                {it.status === "queued" && "รอคิว"}
                {it.status === "done" && "✓ สำเร็จ"}
                {it.status === "error" &&
                  (it.error ? it.error.slice(0, 80) : "ผิดพลาด")}
              </div>
              {it.status === "error" && (
                <button
                  type="button"
                  onClick={() => void runUpload(it.id)}
                  className="absolute top-1 left-1 rounded bg-amber-500 px-1.5 py-0.5 text-[9px] font-bold text-white"
                >
                  ลองใหม่
                </button>
              )}
              <button
                type="button"
                onClick={() => remove(it.id)}
                className="absolute top-1 right-1 rounded-full bg-black/60 h-5 w-5 text-[10px] text-white"
                aria-label="ลบรูป"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
