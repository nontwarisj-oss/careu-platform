"use client";

// <PublicQuoteUploader> — Phase 27B / W3.9 mobile-reliable photo upload
// for the public quote wizard.
//
// Per file the pipeline runs through explicit, bounded stages:
//   preparing → compressing → uploading → done | error
// Every async step has a hard timeout, so a card can NEVER stay stuck:
//   • compress (lib/imageCompress) is bounded — canvas.toBlob /
//     createImageBitmap hang on mobile Safari / the LINE in-app browser.
//   • the upload fetch is bounded by an AbortController.
//   • the response parse is bounded too.
// HEIC that can't be converted in-browser surfaces a clear Thai message
// instead of a doomed upload. Completed storage PATHS are emitted to the
// parent via a real effect (not from inside a setState updater).

import { useCallback, useEffect, useRef, useState } from "react";
import { compressImage, isHeicType } from "@/lib/imageCompress";

const MAX_FILES = 8;
/** Accept large phone originals — we compress them down before upload. */
const ORIGINAL_MAX_BYTES = 15 * 1024 * 1024;
/** Server's hard cap on the compressed file. */
const COMPRESSED_MAX_BYTES = 4 * 1024 * 1024;
/** Per-stage timeouts (ms). No single stage may exceed these. */
const COMPRESS_TIMEOUT_MS = 18000;
const UPLOAD_TIMEOUT_MS = 30000;
const PARSE_TIMEOUT_MS = 8000;

const ALLOWED = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

const HEIC_MSG =
  "รูปจาก iPhone บางไฟล์อัปโหลดไม่ได้ กรุณาถ่ายใหม่เป็น JPG หรือเลือกจากรูปภาพปกติ";

type UploadStatus =
  | "preparing"
  | "compressing"
  | "uploading"
  | "done"
  | "error";

type UploadItem = {
  id: string;
  name: string;
  status: UploadStatus;
  /** Storage path once uploaded — what the quote submits. */
  path: string | null;
  error: string | null;
  /** Local preview object URL. */
  previewUrl: string;
  file: File;
};

const STATUS_LABEL: Record<UploadStatus, string> = {
  preparing: "เตรียมไฟล์...",
  compressing: "กำลังย่อรูป...",
  uploading: "กำลังอัปโหลด...",
  done: "✓ อัปโหลดสำเร็จ",
  error: "อัปโหลดไม่สำเร็จ",
};

function accepted(file: File): string | null {
  const t = file.type.toLowerCase();
  const n = file.name.toLowerCase();
  const okType =
    ALLOWED.includes(t) || n.endsWith(".heic") || n.endsWith(".heif");
  if (!okType) return "ชนิดไฟล์ไม่รองรับ (รองรับ JPG / PNG / WEBP / HEIC)";
  if (file.size > ORIGINAL_MAX_BYTES) return "ไฟล์ใหญ่เกินไป (เกิน 15 MB)";
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_timeout`)), ms)
    ),
  ]);
}

export function PublicQuoteUploader({
  branchCode,
  onChange,
  onProgress,
}: {
  branchCode: string | null;
  /** Called with the list of successfully-uploaded storage paths. */
  onChange: (paths: string[]) => void;
  /** Fires whenever upload state changes so the parent can gate
   *  "Next" / submit while any file is still in flight. */
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

  // Mirror items → onProgress. "In flight" = any stage before done/error.
  useEffect(() => {
    if (!onProgress) return;
    const uploading = items.some(
      (i) =>
        i.status === "preparing" ||
        i.status === "compressing" ||
        i.status === "uploading"
    );
    const done = items.filter((i) => i.status === "done").length;
    const errors = items.filter((i) => i.status === "error").length;
    onProgress({ uploading, done, total: items.length, errors });
  }, [items, onProgress]);

  // Emit completed paths to the parent from a real effect (W3.5) — never
  // from inside a setState updater. ref-diff prevents redundant calls.
  const prevPathsRef = useRef<string>("");
  useEffect(() => {
    const paths = items
      .filter((i) => i.status === "done" && i.path)
      .map((i) => i.path as string);
    const serialized = paths.join("|");
    if (serialized === prevPathsRef.current) return;
    prevPathsRef.current = serialized;
    console.warn("[quote-upload] stage=emit status=paths", {
      count: paths.length,
    });
    onChange(paths);
  }, [items, onChange]);

  /** POST the compressed file via XMLHttpRequest. W3.10: fetch +
   *  AbortController is replaced because the LINE in-app browser can
   *  silently ignore the abort, leaving the card stuck at "กำลังอัปโหลด"
   *  forever. XHR's native .timeout is enforced by the webview's network
   *  layer on every device; an outer withTimeout race is the final
   *  guarantee the promise always settles — the card can never hang.
   *  Returns a Thai error string (with a short tech code) on failure. */
  const doUpload = useCallback(
    async (file: File): Promise<{ path: string | null; error: string | null }> => {
      const fd = new FormData();
      fd.append("file", file, file.name);
      if (branchCode) fd.append("branchCode", branchCode);
      fd.append("groupingToken", groupingToken.current);

      const send = new Promise<{ path: string | null; error: string | null }>(
        (resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/public/upload");
          xhr.timeout = UPLOAD_TIMEOUT_MS;
          xhr.responseType = "text";

          const fail = (code: string) =>
            resolve({
              path: null,
              error: `อัปโหลดไม่สำเร็จ กรุณาลองใหม่ (${code})`,
            });

          xhr.ontimeout = () => fail("upload_timeout");
          xhr.onerror = () => fail("network_error");
          xhr.onabort = () => fail("upload_aborted");
          xhr.onload = () => {
            let json: { ok?: boolean; reason?: string; path?: string };
            try {
              json = JSON.parse(xhr.responseText || "{}") as typeof json;
            } catch {
              fail(`parse_${xhr.status}`);
              return;
            }
            if (
              xhr.status < 200 ||
              xhr.status >= 300 ||
              !json.ok ||
              !json.path
            ) {
              const reason = json.reason
                ? `${json.reason} `
                : "อัปโหลดไม่สำเร็จ ";
              resolve({
                path: null,
                error: `${reason}(server_${xhr.status})`,
              });
              return;
            }
            resolve({ path: json.path, error: null });
          };

          try {
            xhr.send(fd);
          } catch {
            fail("send_failed");
          }
        }
      );

      // Final guarantee: even if no XHR event ever fires, this race
      // settles the promise so the upload card can never hang.
      try {
        return await withTimeout(
          send,
          UPLOAD_TIMEOUT_MS + PARSE_TIMEOUT_MS,
          "upload"
        );
      } catch {
        return {
          path: null,
          error: "อัปโหลดไม่สำเร็จ กรุณาลองใหม่ (upload_timeout)",
        };
      }
    },
    [branchCode]
  );

  const runUpload = useCallback(
    async (id: string) => {
      const update = (status: UploadStatus, patch: Partial<UploadItem> = {}) =>
        setItems((prev) =>
          prev.map((i) => (i.id === id ? { ...i, status, ...patch } : i))
        );

      // Grab the current item (synchronous functional read).
      let snapshot: UploadItem[] = [];
      setItems((prev) => {
        snapshot = prev;
        return prev;
      });
      const target = snapshot.find((i) => i.id === id);
      if (!target) return;

      // ---- compressing ----
      update("compressing", { error: null });
      console.warn("[quote-upload] stage=compressing status=start");
      let compressed: File;
      try {
        compressed = await withTimeout(
          compressImage(target.file),
          COMPRESS_TIMEOUT_MS,
          "compress"
        );
      } catch {
        // Compression hung/timed out — fall back to the original and let
        // the HEIC / size checks below decide.
        console.warn("[quote-upload] stage=compressing status=timeout_fallback");
        compressed = target.file;
      }

      // HEIC that couldn't be converted in-browser.
      if (isHeicType(compressed.type)) {
        console.warn("[quote-upload] stage=compressing status=heic_unconverted");
        update("error", { path: null, error: HEIC_MSG });
        return;
      }

      // Too large after compression (server would reject anyway).
      if (compressed.size > COMPRESSED_MAX_BYTES) {
        console.warn("[quote-upload] stage=compressing status=too_large");
        update("error", {
          path: null,
          error: "ไฟล์ใหญ่เกิน 4 MB หลังย่อ — กรุณาเลือกรูปที่เล็กลง",
        });
        return;
      }

      // ---- uploading ----
      update("uploading");
      console.warn("[quote-upload] stage=uploading status=start");
      const result = await doUpload(compressed);
      if (result.error) {
        console.warn("[quote-upload] stage=uploading status=error");
        update("error", { path: null, error: result.error });
        return;
      }
      console.warn("[quote-upload] stage=done status=ok");
      update("done", { path: result.path, error: null });
    },
    [doUpload]
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
          status: reason ? "error" : "preparing",
          path: null,
          error: reason,
          previewUrl: URL.createObjectURL(file),
          file,
        };
      });
      setItems((prev) => [...prev, ...fresh]);
      for (const it of fresh) {
        if (it.status === "preparing") void runUpload(it.id);
      }
      if (inputRef.current) inputRef.current.value = "";
    },
    [items.length, runUpload]
  );

  const remove = useCallback((id: string) => {
    // Pure updater — emit handled by the items-effect.
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
        สูงสุด {MAX_FILES} รูป · ระบบจะย่อรูปให้อัตโนมัติก่อนอัปโหลด
      </p>

      {items.length > 0 && (
        <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {items.map((it) => {
            const inFlight =
              it.status === "preparing" ||
              it.status === "compressing" ||
              it.status === "uploading";
            return (
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
                  className={`absolute inset-x-0 bottom-0 px-1.5 py-1 text-[9px] leading-tight text-white text-center break-words ${
                    it.status === "error"
                      ? "bg-red-600/80"
                      : it.status === "done"
                        ? "bg-green-700/80"
                        : "bg-black/55"
                  }`}
                >
                  {it.status === "error"
                    ? it.error
                      ? it.error.slice(0, 80)
                      : "อัปโหลดไม่สำเร็จ — ลองใหม่"
                    : STATUS_LABEL[it.status]}
                </div>

                {inFlight && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  </div>
                )}

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
            );
          })}
        </ul>
      )}
    </div>
  );
}
