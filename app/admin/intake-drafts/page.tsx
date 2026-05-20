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
  REVIEW_STATUS_BADGE,
  REVIEW_STATUS_LABELS_TH,
  type DraftStatus,
  type IntakeDraft,
  type ReviewStatus,
} from "@/lib/intakeDrafts";
import {
  calculateServiceQuote,
  getActiveServicePrices,
  type ServicePrice,
} from "@/lib/servicePriceMaster";
import { getSimpleStaffAuthHeaders } from "@/lib/simpleStaffSession";

type UpdatePatch = {
  status?: DraftStatus;
  adminReviewNote?: string;
  reviewStatus?: ReviewStatus;
  confirmedGarmentType?: string | null;
  confirmedRepairCategory?: string | null;
  confirmedRepairArea?: string | null;
  confirmedDifficulty?: string | null;
  confirmedPrice?: number | null;
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
    async (draftId: string): Promise<ClassifySuggestion | null> => {
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
        };
        if (!res.ok || !json.ok || !json.suggestion) {
          setError(json.error ?? `วิเคราะห์ไม่สำเร็จ (HTTP ${res.status})`);
          return null;
        }
        await load();
        return json.suggestion;
      } catch (err) {
        setError(err instanceof Error ? err.message : "วิเคราะห์ไม่สำเร็จ");
        return null;
      } finally {
        setBusyId(null);
      }
    },
    [load]
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

function DraftCard({
  draft,
  busy,
  services,
  onUpdate,
  onClassify,
  onConvert,
}: {
  draft: IntakeDraft;
  busy: boolean;
  services: ServicePrice[];
  onUpdate: (draftId: string, patch: UpdatePatch) => void;
  onClassify: () => Promise<ClassifySuggestion | null>;
  onConvert: (payload: {
    serviceCode: string;
    qty: number;
    urgent: boolean;
  }) => Promise<void>;
}) {
  const [note, setNote] = useState(draft.adminReviewNote ?? "");
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

  const created = draft.createdAt
    ? new Date(draft.createdAt).toLocaleString("th-TH", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "-";

  // Primary user-visible id is the manual code the staff wrote on the bag.
  // draft_code is shown small as the system fallback id (audit only).
  const primaryCode = draft.manualJobCode ?? draft.draftCode;

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
          <span
            className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${
              DRAFT_STATUS_BADGE[draft.status]
            }`}
          >
            {DRAFT_STATUS_LABELS_TH[draft.status]}
          </span>
          <span
            className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${
              REVIEW_STATUS_BADGE[draft.reviewStatus]
            }`}
            title="สถานะการตรวจสอบของเจ้าของร้าน"
          >
            {REVIEW_STATUS_LABELS_TH[draft.reviewStatus]}
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
          <p className="text-gray-700">
            <span className="text-gray-500">โน้ตหน้าร้าน: </span>
            {draft.staffNote}
          </p>
        )}
        {draft.urgentRequested && (
          <p className="inline-block rounded-full bg-yellow-100 border border-yellow-300 px-2 py-0.5 text-[11px] font-bold text-yellow-800">
            ⚡ งานด่วน (คิวงานด่วน)
          </p>
        )}
      </div>

      {/* Media */}
      {draft.media.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {draft.media.map((m) => (
            <div
              key={m.id}
              className="h-20 w-20 overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
            >
              {m.signedUrl ? (
                m.mediaType === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <a href={m.signedUrl} target="_blank" rel="noreferrer">
                    <img
                      src={m.signedUrl}
                      alt="งาน"
                      className="h-full w-full object-cover"
                    />
                  </a>
                ) : (
                  <a
                    href={m.signedUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex h-full w-full flex-col items-center justify-center text-[10px] text-gray-500"
                  >
                    <span className="text-xl">🎥</span>
                    ดูวิดีโอ
                  </a>
                )
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[10px] text-gray-400">
                  สื่อ
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ----- Phase B: AI Analysis Panel ---------------------------------
          Mock/rule-based classifier (lib/intakeClassifier.ts). Never sets
          price or order fields directly - just suggests; the owner must
          confirm via the editor below before convert. */}
      <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/50 px-3 py-2">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-800">
            ผลวิเคราะห์เบื้องต้น (AI)
          </p>
          <button
            type="button"
            disabled={busy || !!draft.convertedOrderId}
            onClick={() => void onClassify()}
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
          service / qty / urgent. */}
      <div className="mt-3 rounded-xl border border-emerald-300 bg-emerald-50/60 px-3 py-2.5">
        <p className="text-[11px] font-bold text-emerald-900">
          อนุมัติและสร้างใบงาน (ใช้ราคาจาก Pricing Master)
        </p>
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
