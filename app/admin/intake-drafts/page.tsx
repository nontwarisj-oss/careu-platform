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
import { RouteGuard } from "@/components/RouteGuard";
import {
  DRAFT_STATUS_BADGE,
  DRAFT_STATUS_LABELS_TH,
  DRAFT_STATUSES,
  type DraftStatus,
  type IntakeDraft,
} from "@/lib/intakeDrafts";

export default function IntakeDraftsPage() {
  return (
    <RouteGuard page="admin">
      <IntakeDraftsInner />
    </RouteGuard>
  );
}

function IntakeDraftsInner() {
  const [drafts, setDrafts] = useState<IntakeDraft[]>([]);
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

  const updateDraft = useCallback(
    async (
      draftId: string,
      patch: { status?: DraftStatus; adminReviewNote?: string }
    ) => {
      setBusyId(draftId);
      try {
        const res = await fetch("/api/admin/intake-drafts/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
              onUpdate={updateDraft}
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
  onUpdate,
}: {
  draft: IntakeDraft;
  busy: boolean;
  onUpdate: (
    draftId: string,
    patch: { status?: DraftStatus; adminReviewNote?: string }
  ) => void;
}) {
  const [note, setNote] = useState(draft.adminReviewNote ?? "");

  const created = draft.createdAt
    ? new Date(draft.createdAt).toLocaleString("th-TH", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "-";

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-lg font-extrabold text-gray-900">
            {draft.draftCode}
          </p>
          <p className="text-[11px] text-gray-500">
            {created}
            {draft.branchId ? ` · ${draft.branchId}` : ""}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-bold ${
            DRAFT_STATUS_BADGE[draft.status]
          }`}
        >
          {DRAFT_STATUS_LABELS_TH[draft.status]}
        </span>
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

      {/* AI placeholder block */}
      <div className="mt-3 rounded-lg border border-dashed border-indigo-200 bg-indigo-50/50 px-3 py-2 text-[11px] text-indigo-700">
        <span className="font-semibold">AI: </span>
        {draft.aiSummary
          ? draft.aiSummary
          : "ยังไม่ประมวลผล — รองรับวิเคราะห์รูป/วิดีโอ/เสียงในเฟสถัดไป"}
        {draft.aiSuggestedServiceCode && (
          <span> · แนะนำ: {draft.aiSuggestedServiceCode}</span>
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

      {/* Prepare order — opens /intake with this draft prefilled */}
      <a
        href={`/intake?draftId=${encodeURIComponent(draft.id)}`}
        target="_blank"
        rel="noreferrer"
        className="mt-2 block rounded-lg bg-green-700 px-3 py-2 text-center text-sm font-bold text-white hover:bg-green-800"
      >
        เปิด /intake เพื่อสร้างใบงานจริง →
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
