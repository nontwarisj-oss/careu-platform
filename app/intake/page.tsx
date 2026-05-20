"use client";

// /intake — front-counter order capture.
//
// Two ways in:
//   • Manual (no query param) — the original flow, unchanged.
//   • From a mobile intake draft (/intake?draftId=…) — the draft is
//     fetched and its customer / note / urgent / branch / photos prefill
//     the form. The admin STILL enters Job ID + service/price and saves
//     manually; nothing is auto-saved. On save the draft is marked
//     CONVERTED_TO_ORDER.

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  IntakeOrderForm,
  type IntakePrefill,
} from "@/components/IntakeOrderForm";
import type { IntakeDraft } from "@/lib/intakeDrafts";
import { getSimpleStaffAuthHeaders } from "@/lib/simpleStaffSession";

export default function IntakePage() {
  return (
    <Suspense
      fallback={
        <IntakeShell>
          <p className="text-sm text-gray-500">กำลังเปิดหน้ารับงาน...</p>
        </IntakeShell>
      }
    >
      <IntakePageInner />
    </Suspense>
  );
}

/** Shared page chrome so the manual + draft paths look identical. */
function IntakeShell({ children }: { children: React.ReactNode }) {
  return (
    // Wide, tablet-first container — the intake form lays itself out in
    // two columns (capture left, sticky summary + save right) on lg+.
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-3 md:p-6 lg:p-8 pt-20 md:pt-6">
      <div className="mx-auto w-full max-w-[1600px]">
        <div className="mb-4 border-l-4 border-yellow-400 pl-4">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS
          </p>
          <h1 className="text-2xl md:text-3xl font-extrabold text-gray-900">
            รับงานหน้าร้าน
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            สาขา → ประเภทงาน → Job ID → ตรวจซ้ำ → ลูกค้า → รายการ → สรุป
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}

function IntakePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const draftId = searchParams.get("draftId");

  const [prefill, setPrefill] = useState<IntakePrefill | undefined>(undefined);
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  // While a draft is loading, hold the form back so its state can seed
  // from `prefill` at mount (the form reads prefill in its initializers).
  const [resolving, setResolving] = useState<boolean>(Boolean(draftId));

  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/admin/intake-drafts?draftId=${encodeURIComponent(draftId)}`
        );
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          drafts?: IntakeDraft[];
        };
        if (cancelled) return;
        const d = json.drafts?.[0];
        if (!res.ok || !json.ok || !d) {
          setDraftError(
            json.error ??
              "ไม่พบ Draft นี้ — เปิดหน้ารับงานแบบกรอกเองได้ตามปกติ"
          );
        } else {
          setDraft(d);
          setPrefill({
            customerName: d.customerName,
            customerPhone: d.customerPhone,
            orderNote: d.staffNote,
            urgent: d.urgentRequested,
            branchId: d.branchId,
            imagePaths: d.media
              .filter((m) => m.mediaType === "image")
              .map((m) => m.fileUrl),
          });
        }
      } catch (err) {
        if (!cancelled) {
          setDraftError(
            err instanceof Error ? err.message : "โหลด Draft ไม่สำเร็จ"
          );
        }
      } finally {
        if (!cancelled) setResolving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const videos = draft?.media.filter((m) => m.mediaType === "video") ?? [];

  return (
    <IntakeShell>
      {/* Draft origin banner */}
      {draft && (
        <div className="mb-4 rounded-xl border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-900">
          <p className="font-semibold">
            สร้างจาก Draft:{" "}
            <span className="font-mono">{draft.draftCode}</span>
            {draft.branchId ? ` · สาขา ${draft.branchId}` : ""}
          </p>
          <p className="mt-0.5 text-xs text-green-800">
            ตรวจข้อมูลลูกค้า แล้วกรอก Job ID + บริการ/ราคา ก่อนกดบันทึกใบงาน
          </p>
          {videos.length > 0 && (
            <p className="mt-1 text-xs">
              วิดีโออ้างอิงจาก Draft:{" "}
              {videos.map((v, i) => (
                <span key={v.id}>
                  {i > 0 ? " · " : ""}
                  {v.signedUrl ? (
                    <a
                      href={v.signedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold underline"
                    >
                      ดูวิดีโอ {i + 1}
                    </a>
                  ) : (
                    <span className="text-green-700">วิดีโอ {i + 1}</span>
                  )}
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {/* Draft lookup failed → fall back to the manual flow with a notice */}
      {draftError && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {draftError}
        </div>
      )}

      {resolving ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          กำลังโหลดข้อมูล Draft...
        </div>
      ) : (
        <>
          <IntakeOrderForm
            prefill={prefill}
            onCreated={(summary) => {
              // Opened from a draft → mark it converted (best-effort; if it
              // fails the admin can still mark it in the review queue).
              if (draftId) {
                void fetch("/api/admin/intake-drafts/update", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...getSimpleStaffAuthHeaders(),
                  },
                  body: JSON.stringify({
                    draftId,
                    status: "CONVERTED_TO_ORDER",
                    convertedOrderId: summary.orderId,
                  }),
                }).catch(() => {});
              }
              // After save, jump straight to the combined document.
              router.push(`/orders/${summary.orderId}/document`);
            }}
          />

          <p className="mt-3 text-[11px] text-gray-500 text-center">
            รับซ่อมได้หลายชิ้นในใบงานเดียว — เพิ่มรายการได้ตามต้องการ
          </p>
        </>
      )}
    </IntakeShell>
  );
}
