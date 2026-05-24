"use client";

// /admin/intake-drafts — Owner/Admin review queue for mobile intake drafts.
//
// Shows every draft captured from the mobile flow with its media, lets the
// reviewer move it through the status workflow, leave a review note, and
// (when ready) open /intake to build the real order. Convert-to-order is
// intentionally NOT automated — a draft has no customer row, service, or
// price, so forcing a conversion would create a junk order. The reviewer
// uses the existing /intake flow and then marks the draft converted.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RouteGuard } from "@/components/RouteGuard";
import {
  DRAFT_STATUS_BADGE,
  DRAFT_STATUS_LABELS_TH,
  DRAFT_STATUSES,
  INTAKE_SOURCE_BADGE,
  INTAKE_SOURCE_LABELS_TH,
  type DraftStatus,
  type IntakeDraft,
  type IntakeDraftMedia,
  type ReviewStatus,
} from "@/lib/intakeDrafts";
import { sanitizeJobIdInput } from "@/lib/jobId";

// ---- Phase B UX: 4-phase progress badge ------------------------------
// Collapses (ai_status, review_status, converted_order_id) into one big
// state for the queue card. Drives both the primary status pill and the
// disabled/enabled state of the AI / review / convert buttons below.

type AdminPhase =
  | "not_classified"
  | "classified_awaiting_review"
  | "reviewed"
  | "converted";

const PHASE_LABEL_TH: Record<AdminPhase, string> = {
  not_classified: "ยังไม่วิเคราะห์",
  classified_awaiting_review: "วิเคราะห์แล้ว รอตรวจ",
  reviewed: "เจ้าของร้านตรวจแล้ว",
  converted: "สร้างใบงานแล้ว",
};

const PHASE_BADGE: Record<AdminPhase, string> = {
  not_classified: "border-gray-300 bg-gray-50 text-gray-700",
  classified_awaiting_review:
    "border-indigo-300 bg-indigo-50 text-indigo-800",
  reviewed: "border-emerald-300 bg-emerald-50 text-emerald-800",
  converted: "border-gray-400 bg-gray-100 text-gray-700",
};

function derivePhase(draft: IntakeDraft): AdminPhase {
  if (draft.reviewStatus === "converted" || draft.convertedOrderId) {
    return "converted";
  }
  if (draft.reviewStatus === "reviewed") return "reviewed";
  if (draft.aiStatus === "classified") return "classified_awaiting_review";
  return "not_classified";
}
import {
  calculateServiceQuote,
  getActiveServicePrices,
  type ServicePrice,
} from "@/lib/servicePriceMaster";
import { getSimpleStaffAuthHeaders } from "@/lib/simpleStaffSession";
import {
  extractLineUserId,
  composeGuidedQuestionMessage,
} from "@/lib/lineReplyDraft";

type UpdatePatch = {
  status?: DraftStatus;
  adminReviewNote?: string;
  reviewStatus?: ReviewStatus;
  confirmedGarmentType?: string | null;
  confirmedRepairCategory?: string | null;
  confirmedRepairArea?: string | null;
  confirmedDifficulty?: string | null;
  confirmedPrice?: number | null;
  manualJobCode?: string | null;
};

type ClassifySuggestion = {
  garment_type: string;
  repair_category: string;
  repair_area: string | null;
  difficulty: string;
  confidence: number;
  summary: string;
  suggested_price: number | null;
  needs_human_review: boolean;
};

// ---- L5 / L6 / L7: Service Router + Guided Question Engine response ----
// The classify route returns these blocks alongside `suggestion`. They are
// not persisted on the draft row — held in card-local state after a
// classify call so the L7 reply panel can render the checklist + draft the
// customer questions.

type RouterBlock = {
  service_domain: string;
  repair_category: string | null;
  confidence: number;
  band: string;
  signals_used: string[];
  alternatives: { serviceDomain: string; confidence: number }[];
  matched_keywords: string[];
};

type ChecklistItemView = {
  kind: string;
  key: string;
  labelTh: string;
  required: boolean;
  questionTh: string;
};

type ChecklistBlock = {
  service_domain: string;
  display_name_th: string;
  have: string[];
  missing: ChecklistItemView[];
  customer_questions: string[];
  required_complete: boolean;
  admin_text: string;
};

type ClassifyResult = {
  suggestion: ClassifySuggestion;
  router: RouterBlock | null;
  checklist: ChecklistBlock | null;
};

const BAND_LABEL_TH: Record<string, string> = {
  high: "มั่นใจสูง",
  medium: "มั่นใจปานกลาง",
  low: "มั่นใจต่ำ",
};

export default function IntakeDraftsPage() {
  return (
    <RouteGuard page="admin">
      <IntakeDraftsInner />
    </RouteGuard>
  );
}

function IntakeDraftsInner() {
  const router = useRouter();
  const [drafts, setDrafts] = useState<IntakeDraft[]>([]);
  const [services, setServices] = useState<ServicePrice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<DraftStatus | "all">("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/intake-drafts");
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        drafts?: IntakeDraft[];
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `โหลดไม่สำเร็จ (HTTP ${res.status})`);
        setDrafts([]);
      } else {
        setDrafts(json.drafts ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "โหลดคิวงานไม่สำเร็จ");
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Load active Pricing Master catalog once — the Approve panel binds its
  // service select to this list, and `calculateServiceQuote` (pure) reads
  // from these rows. Browser anon can read service_price_master.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getActiveServicePrices();
      if (cancelled) return;
      setServices(res.services);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const convertDraft = useCallback(
    async (
      draftId: string,
      payload: { serviceCode: string; qty: number; urgent: boolean }
    ): Promise<{ orderId: string | null; error: string | null }> => {
      setBusyId(draftId);
      try {
        const res = await fetch(
          `/api/admin/intake-drafts/${encodeURIComponent(draftId)}/convert`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...getSimpleStaffAuthHeaders(),
            },
            body: JSON.stringify(payload),
          }
        );
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          orderId?: string;
        };
        if (!res.ok || !json.ok || !json.orderId) {
          const reason = json.error ?? `อนุมัติไม่สำเร็จ (HTTP ${res.status})`;
          setError(reason);
          return { orderId: null, error: reason };
        }
        await load();
        return { orderId: json.orderId, error: null };
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "อนุมัติไม่สำเร็จ — ลองอีกครั้ง";
        setError(msg);
        return { orderId: null, error: msg };
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const updateDraft = useCallback(
    async (draftId: string, patch: UpdatePatch) => {
      setBusyId(draftId);
      try {
        const res = await fetch("/api/admin/intake-drafts/update", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getSimpleStaffAuthHeaders(),
          },
          body: JSON.stringify({ draftId, ...patch }),
        });
        const json = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !json.ok) {
          setError(json.error ?? "อัปเดตไม่สำเร็จ");
        } else {
          await load();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "อัปเดตไม่สำเร็จ");
      }
      setBusyId(null);
    },
    [load]
  );

  const classifyDraft = useCallback(
    async (draftId: string): Promise<ClassifyResult | null> => {
      setBusyId(draftId);
      try {
        const res = await fetch(
          `/api/admin/intake-drafts/${encodeURIComponent(draftId)}/classify`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...getSimpleStaffAuthHeaders(),
            },
          }
        );
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          suggestion?: ClassifySuggestion;
          router?: RouterBlock;
          checklist?: ChecklistBlock;
        };
        if (!res.ok || !json.ok || !json.suggestion) {
          setError(json.error ?? `วิเคราะห์ไม่สำเร็จ (HTTP ${res.status})`);
          return null;
        }
        await load();
        return {
          suggestion: json.suggestion,
          router: json.router ?? null,
          checklist: json.checklist ?? null,
        };
      } catch (err) {
        setError(err instanceof Error ? err.message : "วิเคราะห์ไม่สำเร็จ");
        return null;
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  // L7 — send an admin-reviewed reply to the customer's LINE. The route
  // resolves the LINE userId from the draft + audits every attempt.
  const sendLineReply = useCallback(
    async (
      draftId: string,
      text: string
    ): Promise<{ ok: boolean; reason: string | null }> => {
      setBusyId(draftId);
      try {
        const res = await fetch(
          `/api/admin/intake-drafts/${encodeURIComponent(draftId)}/send-line-reply`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...getSimpleStaffAuthHeaders(),
            },
            body: JSON.stringify({ text }),
          }
        );
        const json = (await res.json()) as { ok?: boolean; reason?: string };
        if (!res.ok || !json.ok) {
          return {
            ok: false,
            reason: json.reason ?? `ส่งไม่สำเร็จ (HTTP ${res.status})`,
          };
        }
        return { ok: true, reason: null };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : "ส่งไม่สำเร็จ",
        };
      } finally {
        setBusyId(null);
      }
    },
    []
  );

  // L8 — send the approved quote (Flex) to the customer's LINE. The price
  // is whatever the admin typed/reviewed on the card (F3 — AI never prices).
  const sendQuote = useCallback(
    async (
      draftId: string,
      payload: { price: number; serviceText: string; validityText: string }
    ): Promise<{ ok: boolean; reason: string | null }> => {
      setBusyId(draftId);
      try {
        const res = await fetch(
          `/api/admin/intake-drafts/${encodeURIComponent(draftId)}/send-quote`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...getSimpleStaffAuthHeaders(),
            },
            body: JSON.stringify(payload),
          }
        );
        const json = (await res.json()) as { ok?: boolean; reason?: string };
        if (!res.ok || !json.ok) {
          return {
            ok: false,
            reason: json.reason ?? `ส่งไม่สำเร็จ (HTTP ${res.status})`,
          };
        }
        return { ok: true, reason: null };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : "ส่งไม่สำเร็จ",
        };
      } finally {
        setBusyId(null);
      }
    },
    []
  );

  const filtered = useMemo(
    () =>
      statusFilter === "all"
        ? drafts
        : drafts.filter((d) => d.status === statusFilter),
    [drafts, statusFilter]
  );

  const counts = useMemo(() => {
    const open = drafts.filter(
      (d) => d.status !== "CONVERTED_TO_ORDER" && d.status !== "CANCELLED"
    ).length;
    return { total: drafts.length, open };
  }, [drafts]);

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-5 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 border-l-4 border-yellow-400 pl-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS
          </p>
          <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
            คิวงาน Mobile Intake
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            งานที่หน้าร้านถ่ายรูปส่งเข้ามา — ตรวจแล้วเปิดสร้างใบงานจริงที่ /intake
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="self-start rounded-lg border border-green-600 px-4 py-2 text-sm font-semibold text-green-700 hover:bg-green-50"
        >
          รีเฟรช
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="rounded-full bg-white border border-gray-200 px-3 py-1 text-sm text-gray-700">
          ทั้งหมด {counts.total}
        </span>
        <span className="rounded-full bg-green-50 border border-green-200 px-3 py-1 text-sm font-semibold text-green-800">
          ค้างตรวจ {counts.open}
        </span>
        <select
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as DraftStatus | "all")
          }
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="all">ทุกสถานะ</option>
          {DRAFT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {DRAFT_STATUS_LABELS_TH[s]}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center text-gray-500">
          กำลังโหลด...
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center text-gray-500">
          {drafts.length === 0
            ? "ยังไม่มีงานจาก Mobile Intake"
            : "ไม่มีงานตามสถานะที่เลือก"}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {filtered.map((draft) => (
            <DraftCard
              key={draft.id}
              draft={draft}
              busy={busyId === draft.id}
              services={services}
              onUpdate={updateDraft}
              onClassify={() => classifyDraft(draft.id)}
              onSendLineReply={(text) => sendLineReply(draft.id, text)}
              onSendQuote={(payload) => sendQuote(draft.id, payload)}
              onConvert={async (payload) => {
                const result = await convertDraft(draft.id, payload);
                if (result.orderId) {
                  // Jump straight to the new document so the reviewer can
                  // hand it to the customer / mark paid.
                  router.push(`/orders/${result.orderId}/document`);
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Media thumbnail (Phase W3.8) ------------------------------------
// One tile per intake_draft_media row. Image thumbnails are served
// through the server-side proxy /api/admin/intake-drafts/media/<id>
// (service-role download, no browser ↔ Storage hop, no signed URL).
// Render paths:
//   1. image + proxy loads ........ thumbnail + "เปิดรูป" (opens proxy in new tab)
//   2. image + onError fires ...... red "โหลดรูปไม่ได้" (links to proxy to read the error)
//   3. video / audio / file ....... icon + download link (still via signed URL)
// The proxy URL is the same for <img src> and the new-tab link, so the
// admin never receives a raw storage path or signed URL for images.
function MediaThumb({ m }: { m: IntakeDraftMedia }) {
  const [imgError, setImgError] = useState(false);

  const typeLabel =
    m.mediaType === "image"
      ? "รูปภาพประกอบ"
      : m.mediaType === "video"
        ? "วิดีโอ"
        : m.mediaType === "audio"
          ? "เสียง"
          : "ไฟล์แนบ";
  const icon =
    m.mediaType === "video"
      ? "🎥"
      : m.mediaType === "audio"
        ? "🎵"
        : "📎";

  // Server-side proxy endpoint for image bytes. Independent of signedUrl.
  const proxyUrl = `/api/admin/intake-drafts/media/${m.id}`;

  return (
    <div className="relative h-20 w-20 overflow-hidden rounded-lg border border-gray-200 bg-gray-100">
      {m.mediaType === "image" && !imgError ? (
        <a
          href={proxyUrl}
          target="_blank"
          rel="noreferrer"
          title="เปิดรูป"
          className="block h-full w-full"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={proxyUrl}
            alt={typeLabel}
            loading="lazy"
            onError={() => {
              console.warn("[intake-media] proxy image failed to load", {
                id: m.id,
                mediaType: m.mediaType,
              });
              setImgError(true);
            }}
            className="h-full w-full object-cover"
          />
          <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[9px] font-semibold text-white">
            เปิดรูป
          </span>
        </a>
      ) : m.mediaType === "image" && imgError ? (
        // Path 2 — proxy couldn't serve the bytes. The link opens the
        // proxy directly so the operator sees the JSON error body
        // (404 / 400 / 500 with a Thai reason).
        <a
          href={proxyUrl}
          target="_blank"
          rel="noreferrer"
          title="โหลดรูปไม่ได้ — กดเพื่อดูสาเหตุจากเซิร์ฟเวอร์"
          className="flex h-full w-full flex-col items-center justify-center gap-0.5 border-2 border-dashed border-red-300 bg-red-50 px-1 text-center text-[9px] font-semibold leading-tight text-red-700"
        >
          <span className="text-base">⚠️</span>
          <span>โหลดรูปไม่ได้</span>
          <span className="text-[8px] font-normal text-red-500 underline">
            ดูสาเหตุ
          </span>
        </a>
      ) : m.signedUrl ? (
        // Path 3 — video / audio / file still use the signed read URL.
        <a
          href={m.signedUrl}
          target="_blank"
          rel="noreferrer"
          title={typeLabel}
          className="flex h-full w-full flex-col items-center justify-center gap-0.5 text-[10px] font-semibold text-gray-600 hover:bg-gray-200"
        >
          <span className="text-xl">{icon}</span>
          <span>{typeLabel}</span>
        </a>
      ) : (
        // Non-image with no signed URL — nothing to link to.
        <div
          title={`${typeLabel} — ไม่สามารถเปิดได้`}
          className="flex h-full w-full flex-col items-center justify-center gap-0.5 text-[10px] text-gray-400"
        >
          <span className="text-xl">{icon}</span>
          <span>{typeLabel}</span>
        </div>
      )}
    </div>
  );
}

function DraftCard({
  draft,
  busy,
  services,
  onUpdate,
  onClassify,
  onSendLineReply,
  onSendQuote,
  onConvert,
}: {
  draft: IntakeDraft;
  busy: boolean;
  services: ServicePrice[];
  onUpdate: (draftId: string, patch: UpdatePatch) => void;
  onClassify: () => Promise<ClassifyResult | null>;
  onSendLineReply: (
    text: string
  ) => Promise<{ ok: boolean; reason: string | null }>;
  onSendQuote: (payload: {
    price: number;
    serviceText: string;
    validityText: string;
  }) => Promise<{ ok: boolean; reason: string | null }>;
  onConvert: (payload: {
    serviceCode: string;
    qty: number;
    urgent: boolean;
  }) => Promise<void>;
}) {
  const [note, setNote] = useState(draft.adminReviewNote ?? "");
  // L5/L6/L7 — full classify response (Router + Guided checklist). Held in
  // card state after a classify call; drives the L7 reply panel below.
  const [classifyResult, setClassifyResult] = useState<ClassifyResult | null>(
    null
  );
  const runClassify = useCallback(async () => {
    const result = await onClassify();
    if (result) setClassifyResult(result);
  }, [onClassify]);
  // Approve panel state — local to each card so changes don't leak.
  const [approveServiceCode, setApproveServiceCode] = useState<string>("");
  const [approveQty, setApproveQty] = useState<number>(1);
  const [approveUrgent, setApproveUrgent] = useState<boolean>(
    draft.urgentRequested
  );

  // Phase B - owner-confirmation editor. Seeds from the draft so that
  // already-saved values render on remount; never auto-saves.
  const [confirmedGarmentType, setConfirmedGarmentType] = useState<string>(
    draft.confirmedGarmentType ?? draft.aiGarmentType ?? ""
  );
  const [confirmedRepairCategory, setConfirmedRepairCategory] =
    useState<string>(
      draft.confirmedRepairCategory ?? draft.aiRepairCategory ?? ""
    );
  const [confirmedRepairArea, setConfirmedRepairArea] = useState<string>(
    draft.confirmedRepairArea ?? draft.aiRepairArea ?? ""
  );
  const [confirmedDifficulty, setConfirmedDifficulty] = useState<string>(
    draft.confirmedDifficulty ?? draft.aiDifficulty ?? ""
  );
  const [confirmedPriceStr, setConfirmedPriceStr] = useState<string>(
    draft.confirmedPrice !== null && draft.confirmedPrice !== undefined
      ? String(draft.confirmedPrice)
      : draft.aiSuggestedPrice !== null && draft.aiSuggestedPrice !== undefined
        ? String(draft.aiSuggestedPrice)
        : ""
  );

  // Phase W2 - owner attaches the bag-tag code to website-sourced drafts
  // (the customer didn't have a bag when they submitted the form).
  // Self-sanitising on keystroke (strip whitespace, uppercase) so the value
  // typed here matches the value written on the bag.
  const [manualJobCodeDraft, setManualJobCodeDraft] = useState<string>(
    draft.manualJobCode ?? ""
  );

  const created = draft.createdAt
    ? new Date(draft.createdAt).toLocaleString("th-TH", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "-";

  // Primary user-visible id is the manual code the staff wrote on the bag.
  // draft_code is shown small as the system fallback id (audit only).
  const primaryCode = draft.manualJobCode ?? draft.draftCode;

  // 4-phase progress — drives the primary badge and the AI-copy button
  // disabled state.
  const phase = derivePhase(draft);

  // Pricing Master row picked by the Approve panel — drives the live quote.
  const pickedService = useMemo(
    () => services.find((s) => s.serviceCode === approveServiceCode) ?? null,
    [services, approveServiceCode]
  );
  const quote = useMemo(
    () =>
      pickedService
        ? calculateServiceQuote(pickedService, approveQty, approveUrgent)
        : null,
    [pickedService, approveQty, approveUrgent]
  );

  const alreadyConverted =
    draft.status === "CONVERTED_TO_ORDER" || !!draft.convertedOrderId;
  const cancelled = draft.status === "CANCELLED";
  // Convert is gated only by "ready to be a real order" — not by the
  // manual queue status. AUTO_QUOTE picks are eligible; GUIDED/MANUAL ones
  // are not (the convert route rejects them and tells the admin to use
  // /intake instead).
  const convertReady =
    !alreadyConverted &&
    !cancelled &&
    !!quote &&
    quote.total !== null &&
    !!draft.manualJobCode;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      {/* Header — manual job code is the primary, big identifier. */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-2xl font-extrabold text-gray-900">
            {primaryCode}
          </p>
          <p className="text-[11px] text-gray-500">
            {draft.manualJobCode
              ? `รหัสถุง · ระบบ: ${draft.draftCode}`
              : `(ไม่มีรหัสรับงาน — ใช้ระบบ ${draft.draftCode})`}
          </p>
          <p className="text-[11px] text-gray-500">
            {created}
            {draft.branchId ? ` · ${draft.branchId}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {/* Primary 4-phase progress: not_classified → classified_awaiting_review
              → reviewed → converted. Replaces the old review-status pill. */}
          <span
            className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${PHASE_BADGE[phase]}`}
            title="ความคืบหน้าตรวจสอบ"
          >
            {PHASE_LABEL_TH[phase]}
          </span>
          {/* Workflow status stays as a small secondary so NEED_CUSTOMER_INFO
              etc. is still visible — distinct axis from the 4-phase pill. */}
          <span
            className={`rounded-full border px-2 py-0 text-[10px] font-semibold ${DRAFT_STATUS_BADGE[draft.status]}`}
            title="สถานะคิวงาน"
          >
            {DRAFT_STATUS_LABELS_TH[draft.status]}
          </span>
          {/* Phase W2: source provenance. "เว็บไซต์" for /quote-bridged
              drafts, "หน้าร้าน" for /mobile-intake. */}
          <span
            className={`rounded-full border px-2 py-0 text-[10px] font-semibold ${INTAKE_SOURCE_BADGE[draft.intakeSource]}`}
            title="ที่มาของ Draft"
          >
            ที่มา: {INTAKE_SOURCE_LABELS_TH[draft.intakeSource]}
          </span>
        </div>
      </div>

      {/* Customer + note */}
      <div className="mt-3 space-y-1 text-sm">
        <p className="text-gray-800">
          <span className="text-gray-500">ลูกค้า: </span>
          {draft.customerName || "(ไม่ระบุ)"}
          {draft.customerPhone ? ` · ${draft.customerPhone}` : ""}
        </p>
        {draft.staffNote && (
          <p className="text-gray-700 whitespace-pre-line">
            <span className="text-gray-500">โน้ต: </span>
            {draft.staffNote}
          </p>
        )}
        {draft.urgentRequested && (
          <p className="inline-block rounded-full bg-yellow-100 border border-yellow-300 px-2 py-0.5 text-[11px] font-bold text-yellow-800">
            ⚡ งานด่วน (คิวงานด่วน)
          </p>
        )}
      </div>

      {/* Phase W2 - editable bag-tag code. Website drafts arrive with
          manual_job_code = null and the owner attaches the real code
          when the customer physically arrives. The Approve & Create
          panel stays disabled until this is saved (convertReady below
          requires !!draft.manualJobCode). */}
      {!draft.convertedOrderId && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50/40 px-3 py-2">
          <label
            htmlFor={`mjc-${draft.id}`}
            className="block text-[11px] font-bold uppercase tracking-wider text-amber-900"
          >
            รหัสรับงาน (เลขคิวที่เขียนติดถุง)
            {!draft.manualJobCode && (
              <span className="ml-1 text-red-600">*</span>
            )}
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id={`mjc-${draft.id}`}
              type="text"
              value={manualJobCodeDraft}
              onChange={(e) =>
                setManualJobCodeDraft(sanitizeJobIdInput(e.target.value))
              }
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="เช่น 36AB"
              className="flex-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-center font-mono text-base font-bold tracking-wider outline-none focus:ring-2 focus:ring-amber-500"
            />
            <button
              type="button"
              disabled={
                busy ||
                manualJobCodeDraft.trim() === (draft.manualJobCode ?? "")
              }
              onClick={() =>
                onUpdate(draft.id, {
                  manualJobCode: manualJobCodeDraft.trim() || null,
                })
              }
              className="rounded-md bg-amber-700 px-3 py-1 text-xs font-bold text-white hover:bg-amber-800 disabled:opacity-40"
            >
              บันทึกรหัส
            </button>
          </div>
          {!draft.manualJobCode && (
            <p className="mt-1 text-[10px] text-amber-800">
              จำเป็นต้องกรอกก่อนกด &quot;อนุมัติและสร้างใบงาน&quot;
            </p>
          )}
        </div>
      )}

      {/* Media — Phase C preview. Admin route signs short-lived read URLs
          (10-min TTL) server-side; the bucket itself remains private.
          Image tiles render the thumbnail; video/audio/file show a
          placeholder card with a download link. */}
      <div className="mt-3">
        <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-500">
          ไฟล์แนบจากลูกค้า
        </p>
        {draft.media.length === 0 ? (
          <p className="text-[11px] italic text-gray-400">ยังไม่มีไฟล์แนบ</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {draft.media.map((m) => (
              <MediaThumb key={m.id} m={m} />
            ))}
          </div>
        )}
      </div>

      {/* ----- Phase B: AI Analysis Panel ---------------------------------
          Mock/rule-based classifier (lib/intakeClassifier.ts). Never sets
          price or order fields directly - just suggests; the owner must
          confirm via the editor below before convert. */}
      <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/50 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-800">
            ผลวิเคราะห์เบื้องต้น (AI)
          </p>
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              disabled={busy || !!draft.convertedOrderId}
              onClick={() => void runClassify()}
              className="rounded-md border border-indigo-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-40"
              title={
                draft.convertedOrderId
                  ? "Draft นี้แปลงเป็น Order แล้ว ไม่สามารถวิเคราะห์ซ้ำได้"
                  : "เรียก mock AI วิเคราะห์ staff_note"
              }
            >
              {draft.aiStatus === "classified"
                ? "วิเคราะห์ซ้ำ"
                : "วิเคราะห์หมวดงาน"}
            </button>
            {/* "ใช้ผล AI นี้เลย" — client-only copy of the AI block into
                the confirmed-field editor state. The owner still has to
                press "บันทึกผลตรวจ" to persist. */}
            <button
              type="button"
              disabled={
                busy ||
                !!draft.convertedOrderId ||
                draft.aiStatus !== "classified"
              }
              onClick={() => {
                setConfirmedGarmentType(draft.aiGarmentType ?? "");
                setConfirmedRepairCategory(draft.aiRepairCategory ?? "");
                setConfirmedRepairArea(draft.aiRepairArea ?? "");
                setConfirmedDifficulty(draft.aiDifficulty ?? "");
                setConfirmedPriceStr(
                  draft.aiSuggestedPrice !== null &&
                    draft.aiSuggestedPrice !== undefined
                    ? String(draft.aiSuggestedPrice)
                    : ""
                );
              }}
              className="rounded-md border border-emerald-400 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-40"
              title={
                draft.aiStatus !== "classified"
                  ? "ต้องวิเคราะห์ก่อน"
                  : "คัดลอกค่าจาก AI ลงในช่องที่ต้องยืนยัน — ยังไม่บันทึกจนกว่าจะกด 'บันทึกผลตรวจ'"
              }
            >
              ใช้ผล AI นี้เลย
            </button>
          </div>
        </div>
        {draft.aiStatus !== "classified" ? (
          <p className="mt-1 text-[11px] text-indigo-600">
            ยังไม่ได้วิเคราะห์ — กดปุ่ม &quot;วิเคราะห์หมวดงาน&quot;
          </p>
        ) : (
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-indigo-900">
            <div>
              <span className="text-indigo-500">ประเภทเสื้อผ้า: </span>
              {draft.aiGarmentType ?? "-"}
            </div>
            <div>
              <span className="text-indigo-500">หมวดงานซ่อม: </span>
              {draft.aiRepairCategory ?? "-"}
            </div>
            <div>
              <span className="text-indigo-500">จุดที่ซ่อม: </span>
              {draft.aiRepairArea ?? "-"}
            </div>
            <div>
              <span className="text-indigo-500">ความยาก: </span>
              {draft.aiDifficulty ?? "-"}
            </div>
            <div>
              <span className="text-indigo-500">ราคาแนะนำเบื้องต้น: </span>
              {draft.aiSuggestedPrice !== null
                ? `฿${draft.aiSuggestedPrice.toFixed(0)}`
                : "-"}
            </div>
            <div>
              <span className="text-indigo-500">ความมั่นใจ: </span>
              {draft.aiConfidence !== null
                ? `${Math.round((draft.aiConfidence ?? 0) * 100)}%`
                : "-"}
            </div>
            {draft.aiSummary && (
              <p className="col-span-2 mt-1 italic text-indigo-700">
                {draft.aiSummary}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ----- Phase C / L7: Guided Question + Reply-to-LINE panel --------
          Renders after a classify call. Shows the L5 Router verdict + the
          L6 missing-info checklist, and lets the admin send the drafted
          questions to the customer's LINE (F3 — admin presses send). */}
      {classifyResult?.checklist && (
        <GuidedReplyPanel
          draft={draft}
          router={classifyResult.router}
          checklist={classifyResult.checklist}
          busy={busy}
          onSendLineReply={onSendLineReply}
        />
      )}

      {/* ----- Phase B: Owner confirmation editor ------------------------- */}
      <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50/40 px-3 py-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-blue-900">
          หมวดงานที่ยืนยัน (เจ้าของร้าน)
        </p>
        <div className="mt-1 grid grid-cols-2 gap-2">
          <input
            type="text"
            value={confirmedGarmentType}
            onChange={(e) => setConfirmedGarmentType(e.target.value)}
            placeholder="ประเภทเสื้อผ้า"
            className="rounded-md border border-blue-300 bg-white px-2 py-1 text-[12px] outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="text"
            value={confirmedRepairCategory}
            onChange={(e) => setConfirmedRepairCategory(e.target.value)}
            placeholder="หมวดงานซ่อม"
            className="rounded-md border border-blue-300 bg-white px-2 py-1 text-[12px] outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="text"
            value={confirmedRepairArea}
            onChange={(e) => setConfirmedRepairArea(e.target.value)}
            placeholder="จุดที่ซ่อม"
            className="rounded-md border border-blue-300 bg-white px-2 py-1 text-[12px] outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="text"
            value={confirmedDifficulty}
            onChange={(e) => setConfirmedDifficulty(e.target.value)}
            placeholder="ความยาก"
            className="rounded-md border border-blue-300 bg-white px-2 py-1 text-[12px] outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="number"
            min={0}
            step={1}
            value={confirmedPriceStr}
            onChange={(e) => setConfirmedPriceStr(e.target.value)}
            placeholder="ราคาเบื้องต้น"
            className="col-span-2 rounded-md border border-blue-300 bg-white px-2 py-1 text-[12px] outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          type="button"
          disabled={busy || !!draft.convertedOrderId}
          onClick={() => {
            const priceNum = confirmedPriceStr.trim()
              ? Number(confirmedPriceStr)
              : null;
            onUpdate(draft.id, {
              confirmedGarmentType: confirmedGarmentType.trim() || null,
              confirmedRepairCategory: confirmedRepairCategory.trim() || null,
              confirmedRepairArea: confirmedRepairArea.trim() || null,
              confirmedDifficulty: confirmedDifficulty.trim() || null,
              confirmedPrice:
                priceNum !== null && Number.isFinite(priceNum)
                  ? priceNum
                  : null,
              reviewStatus: "reviewed",
            });
          }}
          className="mt-2 w-full rounded-md bg-blue-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-800 disabled:opacity-40"
        >
          บันทึกผลตรวจ
        </button>
        {draft.reviewedAt && (
          <p className="mt-1 text-[10px] text-blue-700">
            ตรวจล่าสุด:{" "}
            {new Date(draft.reviewedAt).toLocaleString("th-TH", {
              dateStyle: "short",
              timeStyle: "short",
            })}
            {draft.reviewedBy ? ` · ${draft.reviewedBy.slice(0, 8)}…` : ""}
          </p>
        )}
      </div>

      {/* ----- Phase C / L8: Send quote (Flex) to LINE ------------------- */}
      <SendQuotePanel draft={draft} busy={busy} onSendQuote={onSendQuote} />

      {/* Review note */}
      <div className="mt-3">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="โน้ตการตรวจ (Admin)"
          className="w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => onUpdate(draft.id, { adminReviewNote: note })}
          className="mt-1 rounded-lg border border-gray-300 px-3 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          บันทึกโน้ต
        </button>
      </div>

      {/* Status actions */}
      <div className="mt-3 flex flex-wrap gap-2 border-t border-gray-100 pt-3">
        <ActionButton
          label="กำลังตรวจ"
          tone="amber"
          busy={busy}
          onClick={() => onUpdate(draft.id, { status: "ADMIN_REVIEWING" })}
        />
        <ActionButton
          label="ต้องถามลูกค้า"
          tone="orange"
          busy={busy}
          onClick={() => onUpdate(draft.id, { status: "NEED_CUSTOMER_INFO" })}
        />
        <ActionButton
          label="อนุมัติสร้างงาน"
          tone="green"
          busy={busy}
          onClick={() => onUpdate(draft.id, { status: "APPROVED_TO_ORDER" })}
        />
        <ActionButton
          label="สร้างใบงานแล้ว"
          tone="gray"
          busy={busy}
          onClick={() => onUpdate(draft.id, { status: "CONVERTED_TO_ORDER" })}
        />
        <ActionButton
          label="ยกเลิก"
          tone="red"
          busy={busy}
          onClick={() => onUpdate(draft.id, { status: "CANCELLED" })}
        />
      </div>

      {/* Approve & Create Order — fast path. Price comes from
          Pricing Master via the pure quote engine; the admin only picks
          service / qty / urgent. The confirmed_price the owner saved in
          the review block is shown here as a reference number so the
          Pricing Master pick can be sanity-checked against it. */}
      <div className="mt-3 rounded-xl border border-emerald-300 bg-emerald-50/60 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] font-bold text-emerald-900">
            อนุมัติและสร้างใบงาน (ใช้ราคาจาก Pricing Master)
          </p>
          {draft.confirmedPrice !== null && draft.confirmedPrice !== undefined && (
            <span
              className="rounded-md bg-blue-100 border border-blue-300 px-2 py-0.5 text-[11px] font-bold text-blue-900"
              title="ราคาเบื้องต้นที่เจ้าของร้านยืนยัน — เปรียบเทียบกับราคา Pricing Master ด้านล่าง"
            >
              ราคาเบื้องต้น: ฿{draft.confirmedPrice.toFixed(0)}
            </span>
          )}
        </div>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
          <select
            value={approveServiceCode}
            onChange={(e) => setApproveServiceCode(e.target.value)}
            disabled={busy || alreadyConverted || cancelled}
            className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="">— เลือกบริการ —</option>
            {services.map((s) => (
              <option key={s.serviceCode} value={s.serviceCode}>
                {s.serviceNameTh} ({s.serviceCode})
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            step={1}
            value={approveQty}
            onChange={(e) =>
              setApproveQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))
            }
            disabled={busy || alreadyConverted || cancelled}
            className="w-16 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-center text-xs outline-none focus:ring-2 focus:ring-emerald-500"
            aria-label="จำนวน"
          />
          <button
            type="button"
            onClick={() => setApproveUrgent((u) => !u)}
            disabled={busy || alreadyConverted || cancelled}
            className={`rounded-lg border px-2 py-1.5 text-[11px] font-bold ${
              approveUrgent
                ? "border-yellow-500 bg-yellow-100 text-yellow-800"
                : "border-gray-300 bg-white text-gray-500"
            }`}
          >
            ⚡ ด่วน
          </button>
        </div>
        {/* Live price + mode-specific notice */}
        {quote && (
          <p className="mt-2 text-[11px] text-emerald-900">
            {quote.total !== null ? (
              <>
                รวม{" "}
                <span className="font-mono font-bold">
                  ฿{quote.total.toFixed(2)}
                </span>{" "}
                · {quote.serviceNameTh}
              </>
            ) : (
              <span className="text-amber-800">{quote.noticeTh}</span>
            )}
          </p>
        )}
        <button
          type="button"
          onClick={() =>
            void onConvert({
              serviceCode: approveServiceCode,
              qty: approveQty,
              urgent: approveUrgent,
            })
          }
          disabled={busy || !convertReady}
          className="mt-2 w-full rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-40"
          title={
            !draft.manualJobCode
              ? "Draft นี้ไม่มีรหัสรับงาน — ใช้ /intake ด้านล่างแทน"
              : alreadyConverted
                ? "Draft นี้ถูกสร้างใบงานแล้ว"
                : cancelled
                  ? "Draft นี้ถูกยกเลิก"
                  : !quote || quote.total === null
                    ? "บริการนี้ต้องประเมินมือ — ใช้ /intake ด้านล่างแทน"
                    : "อนุมัติและสร้างใบงาน"
          }
        >
          {busy
            ? "กำลังสร้างใบงาน…"
            : alreadyConverted
              ? "✓ สร้างใบงานแล้ว"
              : "อนุมัติและสร้างใบงาน"}
        </button>
        {alreadyConverted && draft.convertedOrderId && (
          <a
            href={`/orders/${draft.convertedOrderId}/document`}
            className="mt-1 block text-center text-[11px] font-semibold text-emerald-800 underline"
          >
            เปิดใบงาน →
          </a>
        )}
      </div>

      {/* Fallback / manual path — keep the existing /intake link for
          drafts that need full manual entry (guided / manual quote, or
          legacy drafts with no manual_job_code). */}
      <a
        href={`/intake?draftId=${encodeURIComponent(draft.id)}`}
        target="_blank"
        rel="noreferrer"
        className="mt-2 block rounded-lg border border-gray-300 px-3 py-2 text-center text-xs font-semibold text-gray-700 hover:bg-gray-50"
      >
        หรือเปิด /intake (กรอกเอง) →
      </a>
      <p className="mt-1 text-[11px] text-gray-400">
        /intake จะกรอกชื่อ/เบอร์/โน้ต/รูป จาก Draft ให้อัตโนมัติ — กรอก Job ID
        + บริการ/ราคา แล้วบันทึก ระบบจะทำเครื่องหมาย “สร้างใบงานแล้ว” ให้เอง
      </p>
    </div>
  );
}

// ---- Phase C / L7: Guided Question + Reply-to-LINE panel ---------------
// Shows the L5 Service Router verdict + the L6 missing-info checklist, and
// gives the admin a pre-drafted (editable) message to send to the
// customer's LINE. F3: the engine only DRAFTS — the admin reviews the text
// and presses send.
function GuidedReplyPanel({
  draft,
  router,
  checklist,
  busy,
  onSendLineReply,
}: {
  draft: IntakeDraft;
  router: RouterBlock | null;
  checklist: ChecklistBlock;
  busy: boolean;
  onSendLineReply: (
    text: string
  ) => Promise<{ ok: boolean; reason: string | null }>;
}) {
  // The LINE OA bot records the customer's LINE userId inside staff_note.
  // No userId → this draft has no LINE thread to reply to.
  const lineUserId = useMemo(
    () => extractLineUserId(draft.staffNote),
    [draft.staffNote]
  );
  const [text, setText] = useState<string>(() =>
    composeGuidedQuestionMessage(
      draft.customerName,
      checklist.customer_questions
    )
  );
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const hasQuestions = checklist.customer_questions.length > 0;
  const canSend =
    !busy && !sending && !!lineUserId && text.trim().length > 0;

  const doSend = async () => {
    setSending(true);
    setResult(null);
    const r = await onSendLineReply(text.trim());
    setResult({
      ok: r.ok,
      text: r.ok
        ? "ส่งคำถามให้ลูกค้าทาง LINE แล้ว ✓"
        : r.reason ?? "ส่งไม่สำเร็จ",
    });
    setSending(false);
  };

  return (
    <div className="mt-3 rounded-lg border border-teal-300 bg-teal-50/50 px-3 py-2">
      <p className="text-[11px] font-bold uppercase tracking-wider text-teal-800">
        🧵 AI สั่งงาน Intake — ถาม/ตอบ LINE (L6 · L7)
      </p>

      {/* L5 Router verdict */}
      {router && (
        <p className="mt-1 text-[11px] text-teal-900">
          <span className="text-teal-500">หมวดบริการ: </span>
          {checklist.display_name_th}{" "}
          <span className="text-teal-500">({router.service_domain})</span>
          {router.repair_category ? ` · ${router.repair_category}` : ""}
          {" · "}
          {BAND_LABEL_TH[router.band] ?? router.band} (
          {router.confidence.toFixed(2)})
        </p>
      )}

      {/* L6 checklist */}
      <div className="mt-1.5 text-[11px] text-teal-900">
        <p>
          <span className="text-teal-500">✅ มีแล้ว: </span>
          {checklist.have.length > 0 ? checklist.have.join(" · ") : "—"}
        </p>
        {checklist.missing.length === 0 ? (
          <p className="font-semibold text-emerald-700">
            ✔️ ข้อมูลครบสำหรับประเมินราคาแล้ว
          </p>
        ) : (
          <ul className="mt-0.5 space-y-0.5">
            {checklist.missing.map((it) => (
              <li key={`${it.kind}:${it.key}`}>
                {it.required ? "⬜ ยังขาด: " : "▫️ ขอเพิ่ม: "}
                {it.labelTh}
              </li>
            ))}
          </ul>
        )}
        {!checklist.required_complete && (
          <p className="mt-0.5 text-[10px] text-amber-700">
            ⚠️ ข้อมูลยังไม่พอตั้งราคา — ส่งคำถามด้านล่างให้ลูกค้าก่อน
          </p>
        )}
      </div>

      {/* L7 reply-to-LINE */}
      <div className="mt-2 border-t border-teal-200 pt-2">
        <label
          htmlFor={`reply-${draft.id}`}
          className="block text-[11px] font-bold text-teal-800"
        >
          ข้อความถึงลูกค้า (แก้ไขได้ก่อนส่ง)
        </label>
        <textarea
          id={`reply-${draft.id}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={hasQuestions ? 6 : 3}
          placeholder={
            hasQuestions
              ? "ข้อความถึงลูกค้า"
              : "ไม่มีคำถามที่ AI ร่างไว้ — พิมพ์ข้อความถึงลูกค้าเองได้"
          }
          className="mt-1 w-full rounded-md border border-teal-300 bg-white p-2 text-[12px] outline-none focus:ring-2 focus:ring-teal-500"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!canSend}
            onClick={() => void doSend()}
            className="rounded-md bg-teal-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-teal-800 disabled:opacity-40"
            title={
              !lineUserId
                ? "draft นี้ไม่มี LINE userId — ส่งทาง LINE ไม่ได้"
                : text.trim().length === 0
                  ? "ยังไม่มีข้อความ"
                  : "ส่งข้อความนี้ไปที่ LINE ของลูกค้า"
            }
          >
            {sending ? "กำลังส่ง…" : "ส่งคำถามให้ลูกค้า (LINE)"}
          </button>
          {!lineUserId && (
            <span className="text-[10px] text-gray-500">
              draft นี้ไม่มี LINE userId — ตอบกลับทาง LINE ไม่ได้
            </span>
          )}
        </div>
        {result && (
          <p
            className={`mt-1 text-[11px] font-semibold ${
              result.ok ? "text-emerald-700" : "text-red-600"
            }`}
          >
            {result.text}
          </p>
        )}
      </div>
    </div>
  );
}

// ---- Phase C / L8: Send quote (Flex) to LINE --------------------------
// The Owner/Admin enters the approved price + service text and sends the
// customer a Flex "ใบเสนอราคา". F1/F3: the price is human-entered (pre-fills
// from the owner-confirmed price, never the AI suggestion) and a human
// presses send. AI never prices.
function SendQuotePanel({
  draft,
  busy,
  onSendQuote,
}: {
  draft: IntakeDraft;
  busy: boolean;
  onSendQuote: (payload: {
    price: number;
    serviceText: string;
    validityText: string;
  }) => Promise<{ ok: boolean; reason: string | null }>;
}) {
  const lineUserId = useMemo(
    () => extractLineUserId(draft.staffNote),
    [draft.staffNote]
  );
  // Price pre-fills from the OWNER-confirmed price only (F3 — never the AI's).
  const [priceStr, setPriceStr] = useState<string>(
    draft.confirmedPrice !== null && draft.confirmedPrice !== undefined
      ? String(draft.confirmedPrice)
      : ""
  );
  const [serviceText, setServiceText] = useState<string>(
    draft.confirmedRepairCategory ??
      draft.confirmedGarmentType ??
      draft.aiRepairCategory ??
      ""
  );
  const [validityText, setValidityText] = useState<string>(
    "ราคานี้ยืนยัน 7 วัน"
  );
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const priceNum = Number(priceStr);
  const priceOk =
    priceStr.trim().length > 0 && Number.isFinite(priceNum) && priceNum >= 0;
  const canSend =
    !busy && !sending && !!lineUserId && priceOk && serviceText.trim().length > 0;

  const doSend = async () => {
    setSending(true);
    setResult(null);
    const r = await onSendQuote({
      price: priceNum,
      serviceText: serviceText.trim(),
      validityText: validityText.trim(),
    });
    setResult({
      ok: r.ok,
      text: r.ok
        ? "ส่งใบเสนอราคาให้ลูกค้าทาง LINE แล้ว ✓"
        : r.reason ?? "ส่งไม่สำเร็จ",
    });
    setSending(false);
  };

  return (
    <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50/50 px-3 py-2">
      <p className="text-[11px] font-bold uppercase tracking-wider text-amber-800">
        💰 ส่งใบเสนอราคา (Flex) ให้ลูกค้า — L8
      </p>
      <div className="mt-1.5 grid grid-cols-1 gap-2">
        <input
          type="text"
          value={serviceText}
          onChange={(e) => setServiceText(e.target.value)}
          placeholder="บริการที่เสนอราคา เช่น ตัดขากางเกงยีนส์"
          className="rounded-md border border-amber-300 bg-white px-2 py-1 text-[12px] outline-none focus:ring-2 focus:ring-amber-500"
        />
        <div className="grid grid-cols-2 gap-2">
          <input
            type="number"
            min={0}
            step={1}
            value={priceStr}
            onChange={(e) => setPriceStr(e.target.value)}
            placeholder="ราคา (บาท)"
            className="rounded-md border border-amber-300 bg-white px-2 py-1 text-[12px] outline-none focus:ring-2 focus:ring-amber-500"
          />
          <input
            type="text"
            value={validityText}
            onChange={(e) => setValidityText(e.target.value)}
            placeholder="เงื่อนไข/อายุราคา"
            className="rounded-md border border-amber-300 bg-white px-2 py-1 text-[12px] outline-none focus:ring-2 focus:ring-amber-500"
          />
        </div>
      </div>
      {priceOk && serviceText.trim().length > 0 && (
        <p className="mt-1.5 text-[11px] text-amber-900">
          ตัวอย่าง: 💰 ใบเสนอราคา — {serviceText.trim()} ·{" "}
          <span className="font-bold">{priceNum.toLocaleString()} บาท</span>
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!canSend}
          onClick={() => void doSend()}
          className="rounded-md bg-amber-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-800 disabled:opacity-40"
          title={
            !lineUserId
              ? "draft นี้ไม่มี LINE userId — ส่งทาง LINE ไม่ได้"
              : !priceOk
                ? "กรอกราคาให้ถูกต้องก่อน"
                : serviceText.trim().length === 0
                  ? "กรอกบริการก่อน"
                  : "ส่งใบเสนอราคา Flex ไปที่ LINE ของลูกค้า"
          }
        >
          {sending ? "กำลังส่ง…" : "ส่งใบเสนอราคาให้ลูกค้า (LINE)"}
        </button>
        {!lineUserId && (
          <span className="text-[10px] text-gray-500">
            draft นี้ไม่มี LINE userId — ส่งทาง LINE ไม่ได้
          </span>
        )}
      </div>
      <p className="mt-1 text-[10px] text-amber-700">
        ราคานี้เป็นราคาที่เจ้าของร้านกรอกเอง — AI ไม่ตั้งราคา (F3)
      </p>
      {result && (
        <p
          className={`mt-1 text-[11px] font-semibold ${
            result.ok ? "text-emerald-700" : "text-red-600"
          }`}
        >
          {result.text}
        </p>
      )}
    </div>
  );
}

const TONE_CLASS: Record<string, string> = {
  amber: "border-amber-300 text-amber-800 hover:bg-amber-50",
  orange: "border-orange-300 text-orange-800 hover:bg-orange-50",
  green: "border-green-300 text-green-800 hover:bg-green-50",
  gray: "border-gray-300 text-gray-700 hover:bg-gray-50",
  red: "border-red-300 text-red-700 hover:bg-red-50",
};

function ActionButton({
  label,
  tone,
  busy,
  onClick,
}: {
  label: string;
  tone: keyof typeof TONE_CLASS;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1 text-xs font-semibold disabled:opacity-50 ${TONE_CLASS[tone]}`}
    >
      {label}
    </button>
  );
}
