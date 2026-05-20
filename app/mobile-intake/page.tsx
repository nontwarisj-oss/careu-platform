"use client";

// /mobile-intake — Phase 2.5 mobile staff capture flow.
//
// Front-counter reality: no computer, no login, staff not comfortable with
// complex software. This page is deliberately tiny — name, phone, photos /
// video, a short note, an urgent toggle, one big Save button. It creates an
// intake DRAFT (not an order); the owner/admin reviews it later.
//
// It does NOT touch /intake, Pricing Master, or order creation.

import { useCallback, useMemo, useRef, useState } from "react";
import supabase from "@/lib/supabase";
import { useBranch } from "@/lib/branchContext";
import { compressImage } from "@/lib/imageCompress";
import { sanitizeJobIdInput } from "@/lib/jobId";

type MediaItem = {
  localId: string;
  kind: "image" | "video";
  status: "uploading" | "done" | "error";
  previewUrl: string;
  fileUrl?: string;
  error?: string;
};

const MAX_MEDIA = 8;

function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `m-${Math.random().toString(36).slice(2)}`;
}

export default function MobileIntakePage() {
  const { branch } = useBranch();

  // Front-counter queue number — REQUIRED. Continues the shop's running
  // queue, gets written on the bag tag, and becomes orders.job_id on
  // convert. Self-sanitising on every keystroke (drops spaces, uppercases)
  // so staff never need to know the allowed alphabet.
  const [manualJobCode, setManualJobCode] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // The exact code shown big on the success screen — what the staff
  // writes on the bag. Falls back to draftCode for legacy submits.
  const [savedJobCode, setSavedJobCode] = useState<string | null>(null);

  // One grouping token per capture session — clusters this draft's media.
  const groupingToken = useRef(newId());
  const photoInput = useRef<HTMLInputElement | null>(null);
  const videoInput = useRef<HTMLInputElement | null>(null);

  const uploadingCount = useMemo(
    () => media.filter((m) => m.status === "uploading").length,
    [media]
  );

  const uploadOne = useCallback(
    async (
      file: File,
      kind: "image" | "video"
    ): Promise<{ fileUrl?: string; error?: string }> => {
      try {
        // Compress photos to keep mobile-data uploads quick; videos go raw.
        let toUpload: File = file;
        if (kind === "image") {
          try {
            toUpload = await compressImage(file);
          } catch {
            toUpload = file; // compression best-effort
          }
        }
        const res = await fetch("/api/mobile-intake/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mime:
              toUpload.type ||
              (kind === "image" ? "image/jpeg" : "video/mp4"),
            size: toUpload.size,
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
          return { error: json.reason ?? "ขอ URL อัปโหลดไม่สำเร็จ" };
        }
        const up = await supabase.storage
          .from(json.bucket)
          .uploadToSignedUrl(json.path, json.token, toUpload);
        if (up.error) return { error: up.error.message };
        return { fileUrl: json.path };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : "อัปโหลดล้มเหลว",
        };
      }
    },
    []
  );

  const handleFiles = useCallback(
    async (files: FileList | null, kind: "image" | "video") => {
      if (!files || files.length === 0) return;
      setErrorMessage(null);
      const room = MAX_MEDIA - media.length;
      const picked = Array.from(files).slice(0, Math.max(0, room));
      for (const file of picked) {
        const localId = newId();
        const previewUrl = URL.createObjectURL(file);
        setMedia((curr) => [
          ...curr,
          { localId, kind, status: "uploading", previewUrl },
        ]);
        const { fileUrl, error } = await uploadOne(file, kind);
        setMedia((curr) =>
          curr.map((m) =>
            m.localId === localId
              ? error || !fileUrl
                ? { ...m, status: "error", error: error ?? "อัปโหลดล้มเหลว" }
                : { ...m, status: "done", fileUrl }
              : m
          )
        );
      }
      if (photoInput.current) photoInput.current.value = "";
      if (videoInput.current) videoInput.current.value = "";
    },
    [media.length, uploadOne]
  );

  const removeMedia = (localId: string) =>
    setMedia((curr) => curr.filter((m) => m.localId !== localId));

  const resetForm = () => {
    setManualJobCode("");
    setName("");
    setPhone("");
    setNote("");
    setUrgent(false);
    setMedia([]);
    setErrorMessage(null);
    setSavedJobCode(null);
    groupingToken.current = newId();
  };

  const handleSubmit = async () => {
    setErrorMessage(null);
    // Manual job code is the queue number written on the bag — required.
    const code = manualJobCode.trim();
    if (!code) {
      setErrorMessage(
        "กรอกรหัสรับงาน / เลขคิวที่จะเขียนติดถุงงานก่อน (ห้ามว่าง)"
      );
      return;
    }
    if (!name.trim() && !phone.trim() && media.length === 0) {
      setErrorMessage("กรอกชื่อ/เบอร์ลูกค้า หรือถ่ายรูปอย่างน้อย 1 รูป");
      return;
    }
    if (uploadingCount > 0) {
      setErrorMessage("รอรูป/วิดีโออัปโหลดให้เสร็จก่อน");
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/mobile-intake/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: branch.id,
          manualJobCode: code,
          customerName: name.trim() || null,
          customerPhone: phone.trim() || null,
          staffNote: note.trim() || null,
          urgentRequested: urgent,
          media: media
            .filter((m) => m.status === "done" && m.fileUrl)
            .map((m) => ({ mediaType: m.kind, fileUrl: m.fileUrl })),
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        draftCode?: string;
        manualJobCode?: string;
      };
      if (!res.ok || !json.ok || !json.draftCode) {
        setErrorMessage(json.error ?? `บันทึกไม่สำเร็จ (HTTP ${res.status})`);
        return;
      }
      // Show the manual code on the success screen — that's the number
      // staff actually writes on the bag. draftCode is only a fallback.
      setSavedJobCode(json.manualJobCode ?? code ?? json.draftCode);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "บันทึกไม่สำเร็จ — ลองอีกครั้ง"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // ---- Success screen -----------------------------------------------------
  if (savedJobCode) {
    return (
      <div className="flex-1 min-h-screen bg-green-50 px-4 pt-20 pb-10">
        <div className="mx-auto w-full max-w-md">
          <div className="rounded-3xl border-2 border-green-300 bg-white p-6 text-center shadow-sm">
            <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-3xl">
              ✓
            </div>
            <p className="text-xl font-bold text-green-800">บันทึกแล้ว</p>
            <p className="mt-4 text-sm text-gray-500">รหัสรับงาน</p>
            <p className="mt-1 font-mono text-4xl font-extrabold tracking-wider text-gray-900">
              {savedJobCode}
            </p>
            <p className="mt-4 rounded-xl bg-yellow-50 border border-yellow-300 px-4 py-3 text-base font-semibold text-yellow-800">
              ✏️ เขียนเลขนี้ติดถุงงาน
            </p>
            <p className="mt-3 rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 text-sm font-medium text-blue-900 text-left">
              📷 ให้ลูกค้าถ่ายภาพรหัสรับงาน/ถุงงาน แล้วส่งเข้า LINE OA
              เพื่อใช้เป็นหลักฐานตอนมารับงาน
            </p>
          </div>
          <button
            onClick={resetForm}
            className="mt-4 w-full rounded-2xl bg-green-700 py-5 text-lg font-bold text-white shadow-sm active:bg-green-800"
          >
            + บันทึกงานใหม่
          </button>
        </div>
      </div>
    );
  }

  // ---- Capture form -------------------------------------------------------
  const inputClass =
    "w-full rounded-2xl border border-gray-300 p-4 text-base outline-none focus:ring-2 focus:ring-green-500";

  return (
    <div className="flex-1 min-h-screen bg-gray-50 px-4 pt-20 pb-28">
      <div className="mx-auto w-full max-w-md space-y-4">
        <div className="border-l-4 border-yellow-400 pl-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-green-700">
            Care U OPS
          </p>
          <h1 className="text-2xl font-extrabold text-gray-900">รับงานหน้าร้าน</h1>
          <p className="text-xs text-gray-500">
            สาขา {branch.shortLabel} · ถ่ายรูป + เขียนโน้ตสั้น ๆ แล้วกดบันทึก
          </p>
        </div>

        {/* Manual job code — REQUIRED. Self-sanitising on every keystroke
            (uppercase + drops spaces) via sanitizeJobIdInput, so what
            staff types matches what the bag will say. */}
        <div className="space-y-2 rounded-2xl border-2 border-green-400 bg-green-50/40 p-4">
          <label
            htmlFor="manual-job-code"
            className="block text-sm font-extrabold text-green-900"
          >
            รหัสรับงาน / เลขคิวที่เขียนติดถุง
            <span className="ml-1 text-red-600">*</span>
          </label>
          <input
            id="manual-job-code"
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            value={manualJobCode}
            onChange={(e) =>
              setManualJobCode(sanitizeJobIdInput(e.target.value))
            }
            placeholder="เช่น 36XX"
            className="w-full rounded-2xl border-2 border-green-500 bg-white p-4 text-center font-mono text-2xl font-extrabold tracking-wider text-gray-900 outline-none focus:ring-2 focus:ring-green-600"
          />
          <p className="text-[11px] text-green-900/80">
            กรอกเลขคิวงานตามที่หน้าร้านรันต่อจากงานก่อนหน้า
            แล้วเขียนเลขเดียวกันติดถุงงาน
          </p>
        </div>

        {/* Customer */}
        <div className="space-y-3 rounded-2xl border border-gray-200 bg-white p-4">
          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700">
              ชื่อลูกค้า
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ชื่อลูกค้า"
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700">
              เบอร์โทร
            </label>
            <input
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="08x-xxx-xxxx"
              className={inputClass}
            />
          </div>
        </div>

        {/* Media capture */}
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <p className="mb-2 text-sm font-semibold text-gray-700">
            รูป / วิดีโองาน ({media.length}/{MAX_MEDIA})
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => photoInput.current?.click()}
              disabled={media.length >= MAX_MEDIA}
              className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-green-500 bg-green-50 text-base font-bold text-green-700 active:bg-green-100 disabled:opacity-40"
            >
              📷 ถ่ายรูป
            </button>
            <button
              type="button"
              onClick={() => videoInput.current?.click()}
              disabled={media.length >= MAX_MEDIA}
              className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-green-500 bg-green-50 text-base font-bold text-green-700 active:bg-green-100 disabled:opacity-40"
            >
              🎥 วิดีโอ
            </button>
          </div>
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => void handleFiles(e.target.files, "image")}
            className="hidden"
          />
          <input
            ref={videoInput}
            type="file"
            accept="video/*"
            onChange={(e) => void handleFiles(e.target.files, "video")}
            className="hidden"
          />

          {media.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {media.map((m) => (
                <div
                  key={m.localId}
                  className="relative h-20 w-20 overflow-hidden rounded-xl border border-gray-200 bg-gray-100"
                >
                  {m.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={m.previewUrl}
                      alt="งาน"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-2xl">
                      🎥
                    </span>
                  )}
                  {m.status !== "done" && (
                    <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-center text-[9px] text-white">
                      {m.status === "uploading"
                        ? "อัปโหลด..."
                        : m.error ?? "ผิดพลาด"}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeMedia(m.localId)}
                    className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-[10px] text-white"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Note + urgent */}
        <div className="space-y-3 rounded-2xl border border-gray-200 bg-white p-4">
          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700">
              โน้ตสั้น ๆ (ถ้ามี)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="เช่น ซิปเสีย / เปลี่ยนซิป"
              className={inputClass}
            />
          </div>
          <button
            type="button"
            onClick={() => setUrgent((u) => !u)}
            className={`flex w-full items-center justify-between rounded-2xl border-2 px-4 py-3 text-base font-bold ${
              urgent
                ? "border-yellow-500 bg-yellow-100 text-yellow-800"
                : "border-gray-300 bg-white text-gray-600"
            }`}
          >
            <span>⚡ งานด่วน (คิวงานด่วน)</span>
            <span>{urgent ? "เปิด" : "ปิด"}</span>
          </button>
        </div>

        {errorMessage && (
          <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {errorMessage}
          </div>
        )}
      </div>

      {/* Sticky save button */}
      <div className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white p-3">
        <div className="mx-auto w-full max-w-md">
          <button
            onClick={() => void handleSubmit()}
            disabled={isSubmitting || uploadingCount > 0}
            className="w-full rounded-2xl bg-green-700 py-5 text-lg font-bold text-white shadow-sm active:bg-green-800 disabled:opacity-50"
          >
            {isSubmitting
              ? "กำลังบันทึก…"
              : uploadingCount > 0
                ? "รออัปโหลด…"
                : "บันทึกงาน"}
          </button>
        </div>
      </div>
    </div>
  );
}
