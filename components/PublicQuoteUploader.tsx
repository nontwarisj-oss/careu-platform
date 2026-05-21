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

  // Phase W3.5 — emit completed paths to the parent via a real effect,
  // not from inside the setItems updater. React's docs require updater
  // functions to be pure; calling setForm from inside one (via
  // onChange → patch) is officially unsupported and can drop the
  // side effect under concurrent rendering / batching. A ref-tracked
  // diff prevents redundant onChange calls when the parent re-renders
  // without an actual paths change (which would otherwise clobber any
  // photos restored from localStorage on mount with an empty list).
  const prevPathsRef = useRef<string>("");
  useEffect(() => {
    const paths = items
      .filter((i) => i.status === "done" && i.path)
      .map((i) => i.path as string);
    const serialized = paths.join("|");
    if (serialized === prevPathsRef.current) return;
    prevPathsRef.current = serialized;
    console.warn("[quote-upload] emit paths to parent", {
      count: paths.length,
    });
    onChange(paths);
  }, [items, onChange]);

  const uploadOne = useCallback(
    async (item: UploadItem): Promise<{ path: string | null; error: string | null }> => {
      // Phase W3.3 — server-side upload via /api/public/upload.
      // The browser POSTs the compressed file as multipart/form-data.
      // The server uses the service-role key to push the bytes into
      // Storage. Browser never touches Storage directly, so CORS,
      // signed-URL token, and bucket-policy concerns are gone.
      //
      // Stage labels (surfaced on the error card + console):
      //   [compress] | [upload] | [parse] | [upload timeout] | [outer timeout]
      const HARD_TIMEOUT_MS = 45000;
      const REQUEST_TIMEOUT_MS = 40000;

      const doUpload = async (): Promise<{
        path: string | null;
        error: string | null;
      }> => {
        try {
          console.warn("[quote-upload] [compress] start", {
            name: item.name,
            size: item.file.size,
            type: item.file.type,
          });
          let compressed: File;
          try {
            compressed = await compressImage(item.file);
          } catch (compressErr) {
            const msg =
              compressErr instanceof Error
                ? compressErr.message
                : "ย่อรูปไม่สำเร็จ";
            console.warn("[quote-upload] [compress] threw", msg);
            return { path: null, error: `[compress] ${msg}` };
          }
          console.warn("[quote-upload] [compress] ok", {
            size: compressed.size,
            type: compressed.type,
          });

          const fd = new FormData();
          fd.append("file", compressed, compressed.name);
          if (branchCode) fd.append("branchCode", branchCode);
          fd.append("groupingToken", groupingToken.current);

          const ctl = new AbortController();
          const timer = setTimeout(
            () => ctl.abort(),
            REQUEST_TIMEOUT_MS
          );
          let res: Response;
          try {
            res = await fetch("/api/public/upload", {
              method: "POST",
              body: fd,
              signal: ctl.signal,
            });
          } catch (fetchErr) {
            const aborted =
              fetchErr instanceof DOMException &&
              fetchErr.name === "AbortError";
            const msg =
              fetchErr instanceof Error
                ? fetchErr.message
                : "อัปโหลดไม่สำเร็จ";
            console.warn("[quote-upload] [upload] fetch threw", {
              aborted,
              msg,
            });
            return {
              path: null,
              error: aborted
                ? `[upload timeout] เซิร์ฟเวอร์ไม่ตอบสนองภายใน ${Math.round(
                    REQUEST_TIMEOUT_MS / 1000
                  )} วินาที — ลองใหม่`
                : `[upload] เชื่อมเซิร์ฟเวอร์ไม่ได้: ${msg}`,
            };
          } finally {
            clearTimeout(timer);
          }

          let json: {
            ok?: boolean;
            reason?: string;
            bucket?: string;
            path?: string;
          };
          try {
            json = await res.json();
          } catch (parseErr) {
            console.warn("[quote-upload] [parse] JSON parse failed", {
              status: res.status,
              msg:
                parseErr instanceof Error
                  ? parseErr.message
                  : String(parseErr),
            });
            return {
              path: null,
              error: `[parse] อัปโหลดล้มเหลว (HTTP ${res.status})`,
            };
          }
          console.warn("[quote-upload] [upload] response", {
            status: res.status,
            ok: json.ok,
            bucket: json.bucket,
            path: json.path,
            reason: json.reason,
          });

          if (!res.ok || !json.ok || !json.path) {
            return {
              path: null,
              error: `[upload] ${
                json.reason ?? `HTTP ${res.status}`
              }`,
            };
          }
          return { path: json.path, error: null };
        } catch (err) {
          const msg = err instanceof Error ? err.message : "อัปโหลดล้มเหลว";
          console.warn("[quote-upload] uploadOne exception", msg);
          return { path: null, error: `[unknown] ${msg}` };
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
              error: `[outer timeout] อัปโหลดเกินเวลา ${Math.round(
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
      // Pure updater — emit is handled by the items-effect above.
      setItems((prev) =>
        prev.map((i) =>
          i.id === id
            ? {
                ...i,
                status: (error ? "error" : "done") as UploadItem["status"],
                path,
                error,
              }
            : i
        )
      );
    },
    [uploadOne]
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

  const remove = useCallback((id: string) => {
    // Pure updater — emit is handled by the items-effect above.
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

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
