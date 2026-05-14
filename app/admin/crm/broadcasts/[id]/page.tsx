"use client";

// /admin/crm/broadcasts/[id] — single draft editor + audience preview.
//
// Phase 15: NO SEND BUTTON. The page lets operators:
//   • Edit name / notes / channel selection / templates.
//   • Edit the segment definition.
//   • Click "ประมาณการ" to compute audience size + cache as a snapshot.
//   • Archive the draft.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";

type Segment = {
  branchSlugs?: string[];
  tiers?: string[];
  lifecycleStages?: string[];
  customerTypes?: string[];
  retentionScoreGte?: number | null;
  totalSpendGte?: number | null;
  totalOrdersGte?: number | null;
  inactiveDaysGte?: number | null;
  activeWithinDays?: number | null;
  requireLineLink?: boolean;
  requirePhone?: boolean;
};

type Draft = {
  id: string;
  name: string;
  notes: string | null;
  segment: Segment;
  template_sms: string | null;
  template_line: string | null;
  channels: string[];
  status: string;
  branch_id: string | null;
  created_at: string;
  updated_at: string;
};

type Snapshot = {
  id: string;
  total_match: number;
  reachable_line: number;
  reachable_sms: number;
  reachable_email: number;
  opted_out_line: number;
  opted_out_sms: number;
  opted_out_email: number;
  distribution: {
    byBranch?: Record<string, number>;
    byTier?: Record<string, number>;
    byStage?: Record<string, number>;
  };
  estimated_cost_thb: number;
  computed_at: string;
};

const TIERS = ["bronze", "silver", "gold", "platinum", "vip"];
const STAGES = ["new", "active", "reactivated", "at_risk", "dormant", "churned"];
const CHANNELS = ["sms", "line", "email"];

export default function DraftDetailPage() {
  return (
    <RouteGuard page="admin">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/admin/crm/broadcasts/${id}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        draft?: Draft;
        latestSnapshot?: Snapshot | null;
        reason?: string;
      };
      if (!res.ok || !json.ok || !json.draft) {
        setError(json.reason ?? `โหลดล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setDraft(json.draft);
      setSnapshot(json.latestSnapshot ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (patch: Partial<Draft>) => {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.notes !== undefined) body.notes = patch.notes;
      if (patch.segment !== undefined) body.segment = patch.segment;
      if (patch.template_sms !== undefined) body.templateSms = patch.template_sms;
      if (patch.template_line !== undefined) body.templateLine = patch.template_line;
      if (patch.channels !== undefined) body.channels = patch.channels;
      if (patch.status !== undefined) body.status = patch.status;
      const res = await fetch(`/api/admin/crm/broadcasts/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `บันทึกล้มเหลว (HTTP ${res.status})`);
      } else {
        setMessage("บันทึกแล้ว");
        setDraft({ ...draft, ...patch });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(null), 2000);
    }
  };

  const handleEstimate = async () => {
    if (!draft) return;
    setEstimating(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/crm/audiences/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId: draft.id, segment: draft.segment }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        counts?: {
          totalMatch: number;
          reachableLine: number;
          reachableSms: number;
          reachableEmail: number;
          optedOutLine: number;
          optedOutSms: number;
          optedOutEmail: number;
          distribution: Snapshot["distribution"];
        };
        estimatedCostThb?: number;
      };
      if (!res.ok || !json.ok || !json.counts) {
        setError(json.reason ?? `ประมาณการล้มเหลว (HTTP ${res.status})`);
      } else {
        setSnapshot({
          id: "fresh",
          total_match: json.counts.totalMatch,
          reachable_line: json.counts.reachableLine,
          reachable_sms: json.counts.reachableSms,
          reachable_email: json.counts.reachableEmail,
          opted_out_line: json.counts.optedOutLine,
          opted_out_sms: json.counts.optedOutSms,
          opted_out_email: json.counts.optedOutEmail,
          distribution: json.counts.distribution,
          estimated_cost_thb: json.estimatedCostThb ?? 0,
          computed_at: new Date().toISOString(),
        });
        // Status auto-flips to 'preview' on first estimate.
        if (draft.status === "draft") {
          setDraft({ ...draft, status: "preview" });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setEstimating(false);
    }
  };

  if (loading) {
    return (
      <RouteGuard page="admin">
        <div className="p-8 text-gray-500">โหลด...</div>
      </RouteGuard>
    );
  }

  if (error && !draft) {
    return (
      <div className="p-8 max-w-md mx-auto">
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
          <div className="mt-3">
            <Link
              href="/admin/crm/broadcasts"
              className="text-green-700 underline"
            >
              กลับไปรายการ
            </Link>
          </div>
        </div>
      </div>
    );
  }
  if (!draft) return null;

  const archived = draft.status === "archived";

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <Link href="/admin/crm/broadcasts" className="hover:text-green-700">
            CRM
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium truncate max-w-[40ch]">
            {draft.name}
          </span>
        </div>

        {message && (
          <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
            {message}
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold text-gray-900">รายละเอียด draft</h2>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                archived
                  ? "border-gray-200 bg-gray-50 text-gray-600"
                  : draft.status === "preview"
                    ? "border-blue-200 bg-blue-50 text-blue-900"
                    : "border-yellow-200 bg-yellow-50 text-yellow-800"
              }`}
            >
              {draft.status}
            </span>
          </div>

          <Field
            label="ชื่อ"
            value={draft.name}
            onChange={(v) => void patch({ name: v })}
            disabled={archived}
          />
          <Field
            label="หมายเหตุ"
            value={draft.notes ?? ""}
            onChange={(v) => void patch({ notes: v || null })}
            disabled={archived}
            multiline
          />

          <div>
            <p className="text-[11px] font-semibold text-gray-700 mb-1">
              ช่องทาง
            </p>
            <div className="flex flex-wrap gap-1">
              {CHANNELS.map((c) => {
                const on = draft.channels.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    disabled={archived || saving}
                    onClick={() =>
                      void patch({
                        channels: on
                          ? draft.channels.filter((ch) => ch !== c)
                          : [...draft.channels, c],
                      })
                    }
                    className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                      on
                        ? "border-green-500 bg-green-50 text-green-800"
                        : "border-gray-200 bg-white text-gray-600"
                    } disabled:opacity-50`}
                  >
                    {c.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
          <h2 className="text-base font-bold text-gray-900">Segment</h2>
          <SegmentPills
            label="Tiers"
            options={TIERS}
            value={draft.segment.tiers ?? []}
            onChange={(v) =>
              void patch({ segment: { ...draft.segment, tiers: v } })
            }
            disabled={archived}
          />
          <SegmentPills
            label="Stages"
            options={STAGES}
            value={draft.segment.lifecycleStages ?? []}
            onChange={(v) =>
              void patch({
                segment: { ...draft.segment, lifecycleStages: v },
              })
            }
            disabled={archived}
          />
          <NumberRow
            label="Total spend ≥ (฿)"
            value={draft.segment.totalSpendGte ?? null}
            onCommit={(v) =>
              void patch({ segment: { ...draft.segment, totalSpendGte: v } })
            }
            disabled={archived}
          />
          <NumberRow
            label="Inactive ≥ (days)"
            value={draft.segment.inactiveDaysGte ?? null}
            onCommit={(v) =>
              void patch({ segment: { ...draft.segment, inactiveDaysGte: v } })
            }
            disabled={archived}
          />

          <button
            type="button"
            onClick={() => void handleEstimate()}
            disabled={archived || estimating}
            className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {estimating ? "กำลังประมาณ..." : "ประมาณการ audience"}
          </button>
        </section>

        {snapshot && (
          <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-gray-900">
                ผลประมาณการล่าสุด
              </h2>
              <span className="text-[10px] text-gray-500">
                {new Date(snapshot.computed_at).toLocaleString("th-TH", {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              <KPI label="ทั้งหมด" value={snapshot.total_match} />
              <KPI label="SMS reachable" value={snapshot.reachable_sms} tone="green" />
              <KPI label="LINE reachable" value={snapshot.reachable_line} tone="green" />
              <KPI label="ค่าใช้จ่ายประมาณ" value={`฿${snapshot.estimated_cost_thb}`} tone="amber" />
              <KPI label="SMS opt-out" value={snapshot.opted_out_sms} tone="red" />
              <KPI label="LINE opt-out" value={snapshot.opted_out_line} tone="red" />
              <KPI label="อีเมล reachable" value={snapshot.reachable_email} />
              <KPI label="อีเมล opt-out" value={snapshot.opted_out_email} tone="red" />
            </div>
            <DistBlock title="แยกตามสาขา" data={snapshot.distribution.byBranch} />
            <DistBlock title="แยกตาม tier" data={snapshot.distribution.byTier} />
            <DistBlock title="แยกตาม stage" data={snapshot.distribution.byStage} />
          </section>
        )}

        <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
          <h2 className="text-base font-bold text-gray-900">เนื้อหา</h2>
          <Field
            label="SMS body (≤ 160 ตัวอักษรเหมาะกับ 1 segment)"
            value={draft.template_sms ?? ""}
            onChange={(v) => void patch({ template_sms: v || null })}
            disabled={archived}
            multiline
          />
          <Field
            label="LINE body"
            value={draft.template_line ?? ""}
            onChange={(v) => void patch({ template_line: v || null })}
            disabled={archived}
            multiline
          />
          <TemplatePreview body={draft.template_sms} channel="SMS" />
          <TemplatePreview body={draft.template_line} channel="LINE" />
        </section>

        <SendSection
          draftId={draft.id}
          draftStatus={draft.status}
        />

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-bold text-gray-900">การจัดการ</h2>
          <p className="mt-1 text-xs text-gray-500">
            Archive แล้วยังกู้คืนได้โดยเปลี่ยน status เป็น &quot;draft&quot;
          </p>
          <div className="mt-3 flex gap-2">
            {!archived ? (
              <button
                type="button"
                onClick={() => void patch({ status: "archived" })}
                className="rounded-xl border border-red-200 bg-red-50 hover:bg-red-100 text-red-800 px-3 py-2 text-sm font-semibold"
              >
                Archive draft นี้
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void patch({ status: "draft" })}
                className="rounded-xl border border-green-200 bg-green-50 hover:bg-green-100 text-green-800 px-3 py-2 text-sm font-semibold"
              >
                Restore draft
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  multiline?: boolean;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  const commit = () => {
    if (local !== value) onChange(local);
  };
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-gray-700">{label}</span>
      {multiline ? (
        <textarea
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
          disabled={disabled}
          rows={3}
          className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
        />
      ) : (
        <input
          type="text"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
          disabled={disabled}
          className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
        />
      )}
    </label>
  );
}

function SegmentPills({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold text-gray-700 mb-1">{label}</p>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => {
          const on = value.includes(o);
          return (
            <button
              key={o}
              type="button"
              disabled={disabled}
              onClick={() =>
                onChange(on ? value.filter((v) => v !== o) : [...value, o])
              }
              className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                on
                  ? "border-green-500 bg-green-50 text-green-800"
                  : "border-gray-200 bg-white text-gray-600"
              } disabled:opacity-50`}
            >
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NumberRow({
  label,
  value,
  onCommit,
  disabled,
}: {
  label: string;
  value: number | null;
  onCommit: (v: number | null) => void;
  disabled?: boolean;
}) {
  const [local, setLocal] = useState<string>(value == null ? "" : String(value));
  useEffect(() => {
    setLocal(value == null ? "" : String(value));
  }, [value]);
  const commit = () => {
    const v = local.trim();
    const next = v === "" ? null : Number(v);
    if (next !== value) onCommit(next);
  };
  return (
    <div className="flex items-center justify-between gap-3">
      <label className="text-[11px] font-semibold text-gray-700">{label}</label>
      <input
        type="number"
        inputMode="numeric"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        disabled={disabled}
        className="w-28 rounded-lg border border-gray-200 px-2 py-1 text-sm text-right disabled:bg-gray-50"
      />
    </div>
  );
}

function KPI({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "green" | "red" | "amber";
}) {
  const valueClass =
    tone === "green"
      ? "text-green-800"
      : tone === "red"
        ? "text-red-700"
        : tone === "amber"
          ? "text-amber-800"
          : "text-gray-900";
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
        {label}
      </p>
      <p className={`mt-0.5 text-lg font-extrabold ${valueClass}`}>{value}</p>
    </div>
  );
}

function DistBlock({
  title,
  data,
}: {
  title: string;
  data: Record<string, number> | undefined;
}) {
  if (!data) return null;
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-1">
        {title}
      </p>
      <div className="space-y-1">
        {entries
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 text-[11px]">
              <span className="w-32 truncate text-gray-700">{k}</span>
              <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-green-500"
                  style={{ width: `${(v / max) * 100}%` }}
                />
              </div>
              <span className="w-10 text-right text-gray-600">{v}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

type SendJob = {
  id: string;
  status: string;
  mode: string;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  paused_at: string | null;
  cancelled_at: string | null;
  expected_total: number | null;
  channels: string[];
  created_at: string;
  failure_reason: string | null;
};

const JOB_STATUS_TONE: Record<string, string> = {
  queued: "border-yellow-200 bg-yellow-50 text-yellow-800",
  processing: "border-blue-200 bg-blue-50 text-blue-900",
  paused: "border-amber-200 bg-amber-50 text-amber-900",
  completed: "border-green-200 bg-green-50 text-green-800",
  cancelled: "border-gray-300 bg-gray-100 text-gray-700",
  failed: "border-red-200 bg-red-50 text-red-800",
};

const JOB_STATUS_LABEL: Record<string, string> = {
  queued: "รอเริ่ม",
  processing: "กำลังส่ง",
  paused: "หยุดชั่วคราว",
  completed: "เสร็จสิ้น",
  cancelled: "ยกเลิก",
  failed: "ล้มเหลว",
};

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("th-TH", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function SendSection({
  draftId,
  draftStatus,
}: {
  draftId: string;
  draftStatus: string;
}) {
  const [jobs, setJobs] = useState<SendJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scheduledFor, setScheduledFor] = useState<string>("");
  const [busy, setBusy] = useState<"live" | "dry_run" | "scheduled" | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/crm/broadcasts/${draftId}/jobs`, {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        jobs?: SendJob[];
        reason?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `โหลดล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setJobs(json.jobs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSend = async (
    mode: "live" | "dry_run",
    when: "now" | "scheduled"
  ) => {
    setError(null);
    setMessage(null);
    const stamp =
      when === "scheduled" && scheduledFor
        ? new Date(scheduledFor).toISOString()
        : null;
    if (when === "scheduled" && !stamp) {
      setError("กรุณาเลือกวันเวลาที่จะส่ง");
      return;
    }
    if (
      mode === "live" &&
      !window.confirm(
        when === "scheduled"
          ? `ตั้งเวลาส่งจริงให้ลูกค้า ตามเวลาที่เลือก — ยืนยัน?`
          : "ส่งจริงให้ลูกค้าตอนนี้ — ยืนยัน?"
      )
    ) {
      return;
    }
    setBusy(when === "scheduled" ? "scheduled" : mode);
    try {
      const res = await fetch(`/api/admin/crm/broadcasts/${draftId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, scheduledFor: stamp }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        sendJobId?: string;
        expectedTargets?: number;
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `ส่งล้มเหลว (HTTP ${res.status})`);
      } else {
        setMessage(
          mode === "dry_run"
            ? `dry-run job #${json.sendJobId?.slice(0, 8)} สร้างแล้ว (${json.expectedTargets ?? 0} เป้าหมาย)`
            : `job #${json.sendJobId?.slice(0, 8)} สร้างแล้ว (${json.expectedTargets ?? 0} เป้าหมาย)`
        );
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  };

  const disabled =
    draftStatus === "archived" ||
    busy !== null;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-gray-900">การส่ง</h2>
        {draftStatus === "archived" && (
          <span className="text-[10px] text-gray-500">
            draft archive แล้ว — restore ก่อนส่ง
          </span>
        )}
      </div>

      {message && (
        <div className="mt-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
          {message}
        </div>
      )}
      {error && (
        <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="mt-3 grid sm:grid-cols-3 gap-3">
        <button
          type="button"
          onClick={() => void handleSend("dry_run", "now")}
          disabled={disabled}
          className="rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 disabled:opacity-50"
        >
          {busy === "dry_run" ? "..." : "Dry-run (ไม่ส่งจริง)"}
        </button>
        <button
          type="button"
          onClick={() => void handleSend("live", "now")}
          disabled={disabled}
          className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {busy === "live" ? "..." : "ส่งตอนนี้ (live)"}
        </button>
        <div className="flex items-center gap-2">
          <input
            type="datetime-local"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
            disabled={disabled}
            className="flex-1 rounded-xl border border-gray-200 px-2 py-2 text-xs disabled:bg-gray-50"
          />
          <button
            type="button"
            onClick={() => void handleSend("live", "scheduled")}
            disabled={disabled || !scheduledFor}
            className="rounded-xl bg-amber-600 hover:bg-amber-700 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 whitespace-nowrap"
          >
            {busy === "scheduled" ? "..." : "ตั้งเวลา"}
          </button>
        </div>
      </div>
      <p className="mt-2 text-[10px] text-gray-500">
        ส่งจริงจะเกิดในช่วง 09:00–19:00 (เวลาไทย) เท่านั้น —
        งาน dry-run และตั้งเวลาก็เคารพหน้าต่างเดียวกัน
      </p>

      <div className="mt-5 border-t border-gray-100 pt-4">
        <h3 className="text-sm font-semibold text-gray-800">งานส่งที่ผ่านมา</h3>
        {loading ? (
          <p className="mt-2 text-xs text-gray-500">โหลด...</p>
        ) : jobs.length === 0 ? (
          <p className="mt-2 text-xs text-gray-500">
            ยังไม่มีงานส่ง — กดปุ่มข้างบนเพื่อเริ่มต้น
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-100">
            {jobs.map((j) => (
              <li key={j.id} className="py-2 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/admin/crm/broadcasts/${draftId}/jobs/${j.id}`}
                      className="font-mono text-xs text-green-700 hover:underline"
                    >
                      #{j.id.slice(0, 8)}
                    </Link>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                        JOB_STATUS_TONE[j.status] ?? JOB_STATUS_TONE.queued
                      }`}
                    >
                      {JOB_STATUS_LABEL[j.status] ?? j.status}
                    </span>
                    {j.mode === "dry_run" && (
                      <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-600">
                        dry-run
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[10px] text-gray-500">
                    {j.expected_total != null ? `${j.expected_total} เป้าหมาย` : "ยังไม่ fan-out"} ·{" "}
                    {j.scheduled_for
                      ? `เริ่ม ${fmtDateTime(j.scheduled_for)}`
                      : `สร้าง ${fmtDateTime(j.created_at)}`}
                    {j.failure_reason && (
                      <span className="text-red-600 ml-2">
                        — {j.failure_reason}
                      </span>
                    )}
                  </div>
                </div>
                <Link
                  href={`/admin/crm/broadcasts/${draftId}/jobs/${j.id}`}
                  className="text-[11px] text-green-700 hover:text-green-900 font-semibold whitespace-nowrap"
                >
                  ดูสถานะ →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function TemplatePreview({
  body,
  channel,
}: {
  body: string | null;
  channel: "SMS" | "LINE";
}) {
  if (!body || !body.trim()) return null;
  return (
    <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-gray-50 to-white p-3">
      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-1">
        ตัวอย่าง {channel}
      </p>
      <pre className="whitespace-pre-wrap text-xs text-gray-800 font-sans leading-relaxed">
        {body}
      </pre>
      {channel === "SMS" && body.length > 160 && (
        <p className="mt-1 text-[10px] text-amber-700">
          ยาวเกิน 160 ตัวอักษร — จะถูกแบ่งเป็นหลาย SMS segment (เพิ่มค่าใช้จ่าย)
        </p>
      )}
    </div>
  );
}
