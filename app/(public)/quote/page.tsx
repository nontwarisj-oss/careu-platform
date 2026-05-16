"use client";

// /quote — Phase 27B multi-step public quote wizard.
//
// Four steps: service → photos → details → contact + review.
// Progress auto-saves to localStorage so an anonymous visitor can
// close the tab and resume later. Photos upload through the safe
// signed-upload pipeline (<PublicQuoteUploader>). On success the
// customer can continue the conversation on LINE.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { defaultBrandTheme } from "@/lib/publicTheme";
import { SERVICE_CATEGORIES } from "@/lib/pricing";
import { PublicQuoteUploader } from "@/components/PublicQuoteUploader";

type BranchOption = {
  code: string;
  label: string;
  brand: string | null;
  status?: "open" | "closed" | "unknown";
  statusLabel?: string;
};

type WizardForm = {
  serviceCategory: string;
  notes: string;
  photos: string[];
  branchCode: string;
  urgency: "standard" | "urgent";
  fulfilment: "in_store" | "pickup" | "delivery";
  name: string;
  phone: string;
  email: string;
  contactMethod: "phone" | "line" | "email" | "any";
};

const EMPTY: WizardForm = {
  serviceCategory: "",
  notes: "",
  photos: [],
  branchCode: "",
  urgency: "standard",
  fulfilment: "in_store",
  name: "",
  phone: "",
  email: "",
  contactMethod: "phone",
};

const DRAFT_KEY = "careu_quote_draft_v1";
const LINE_URL = process.env.NEXT_PUBLIC_LINE_OA_URL ?? "/contact";

const STEPS = ["บริการ", "รูปภาพ", "รายละเอียด", "ติดต่อ"];

type SubmitResult =
  | { ok: true; quoteRequestId: string; receivedAt: string; nextSteps: string[] }
  | { ok: false; reason: string };

export default function QuoteWizardPage() {
  const theme = defaultBrandTheme();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<WizardForm>(EMPTY);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [draftFound, setDraftFound] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // ----- Restore draft + query-param pre-fill -----
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const branch = params.get("branch") ?? "";
    let restored: Partial<WizardForm> = {};
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        restored = JSON.parse(raw) as Partial<WizardForm>;
        if (Object.keys(restored).length > 0) setDraftFound(true);
      }
    } catch {
      // ignore corrupt draft
    }
    setForm({
      ...EMPTY,
      ...restored,
      ...(branch ? { branchCode: branch } : {}),
    });
    setHydrated(true);
  }, []);

  // ----- Persist draft on every change (after hydration) -----
  useEffect(() => {
    if (!hydrated || result?.ok) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(form));
    } catch {
      // storage full / disabled — non-fatal
    }
  }, [form, hydrated, result]);

  // ----- Branch list -----
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/public/branches-list");
        if (!res.ok) return;
        const json = (await res.json()) as { branches?: BranchOption[] };
        setBranches(json.branches ?? []);
      } catch {
        setBranches([]);
      }
    })();
  }, []);

  const patch = useCallback(
    (p: Partial<WizardForm>) => setForm((f) => ({ ...f, ...p })),
    []
  );

  const clearDraft = () => {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      // ignore
    }
    setForm(EMPTY);
    setDraftFound(false);
    setStep(0);
  };

  const submit = async () => {
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/public/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          phone: form.phone,
          email: form.email || null,
          branchCode: form.branchCode || null,
          serviceCategory: form.serviceCategory || null,
          contactMethod: form.contactMethod,
          notes: form.notes,
          photos: form.photos,
          urgency: form.urgency,
          fulfilmentPreference: form.fulfilment,
          referrerUrl: window.location.href,
        }),
      });
      const json = (await res.json()) as SubmitResult;
      setResult(json);
      if (json.ok) {
        try {
          localStorage.removeItem(DRAFT_KEY);
        } catch {
          // ignore
        }
      }
    } catch (err) {
      setResult({
        ok: false,
        reason: err instanceof Error ? err.message : "ส่งคำขอไม่สำเร็จ",
      });
    }
    setSubmitting(false);
  };

  // Per-step "can advance" gate.
  const canNext =
    step === 0
      ? form.notes.trim().length > 0 || form.serviceCategory !== ""
      : step === 3
        ? form.phone.trim().length > 0
        : true;

  if (result?.ok) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10">
        <SuccessCard result={result} />
      </div>
    );
  }

  return (
    <div>
      <section className={`bg-gradient-to-r ${theme.accentClass} text-white`}>
        <div className="max-w-3xl mx-auto px-4 py-8">
          <h1 className="text-2xl sm:text-3xl font-extrabold">ขอใบเสนอราคา</h1>
          <p className="mt-1 text-sm opacity-90">
            กรอกทีละขั้น — ระบบบันทึกความคืบหน้าไว้ให้อัตโนมัติ
          </p>
        </div>
      </section>

      <section className="max-w-3xl mx-auto px-4 py-6">
        {/* Step indicator */}
        <ol
          className="flex items-center gap-1"
          aria-label={`ขั้นตอนที่ ${step + 1} จาก ${STEPS.length}: ${STEPS[step]}`}
        >
          {STEPS.map((label, i) => (
            <li key={label} className="flex-1">
              <div
                aria-hidden="true"
                className={`h-1.5 rounded-full ${
                  i <= step ? "bg-green-600" : "bg-gray-200"
                }`}
              />
              <span
                aria-current={i === step ? "step" : undefined}
                className={`mt-1 block text-[10px] font-semibold ${
                  i === step ? "text-green-700" : "text-gray-400"
                }`}
              >
                {i + 1}. {label}
              </span>
            </li>
          ))}
        </ol>

        {/* Resume banner */}
        {draftFound && step === 0 && (
          <div className="mt-4 flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span>พบแบบร่างที่บันทึกไว้ — กรอกต่อได้เลย</span>
            <button
              type="button"
              onClick={clearDraft}
              className="font-semibold underline shrink-0"
            >
              เริ่มใหม่
            </button>
          </div>
        )}

        {result && !result.ok && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {result.reason}
          </div>
        )}

        <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-5">
          {/* ----- Step 0: service ----- */}
          {step === 0 && (
            <div className="space-y-4">
              <Field label="ประเภทบริการ">
                <select
                  value={form.serviceCategory}
                  onChange={(e) => patch({ serviceCategory: e.target.value })}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="">— เลือกประเภท —</option>
                  {SERVICE_CATEGORIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.labelTh}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="เล่ารายละเอียดงาน *">
                <textarea
                  value={form.notes}
                  onChange={(e) => patch({ notes: e.target.value })}
                  rows={5}
                  placeholder="เช่น กางเกงยีนส์ขาดที่หัวเข่า อยากให้ปะแบบไม่เห็นรอย"
                  className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
                />
              </Field>
            </div>
          )}

          {/* ----- Step 1: photos ----- */}
          {step === 1 && (
            <div className="space-y-3">
              <h2 className="font-bold text-gray-900">แนบรูปงาน (ถ้ามี)</h2>
              <p className="text-sm text-gray-600">
                รูปช่วยให้ช่างประเมินราคาได้แม่นยำขึ้น — ข้ามได้ถ้ายังไม่มี
              </p>
              <PublicQuoteUploader
                branchCode={form.branchCode || null}
                onChange={(paths) => patch({ photos: paths })}
              />
            </div>
          )}

          {/* ----- Step 2: details ----- */}
          {step === 2 && (
            <div className="space-y-4">
              <Field label="สาขาที่ต้องการใช้บริการ">
                <select
                  value={form.branchCode}
                  onChange={(e) => patch({ branchCode: e.target.value })}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="">— ให้ทางร้านแนะนำ —</option>
                  {branches.map((b) => (
                    <option key={b.code} value={b.code}>
                      {b.label}
                      {b.statusLabel ? ` · ${b.statusLabel}` : ""}
                    </option>
                  ))}
                </select>
                {(() => {
                  const sel = branches.find((b) => b.code === form.branchCode);
                  if (sel?.status === "closed") {
                    return (
                      <p className="mt-1 text-[11px] text-amber-700">
                        สาขานี้ปิดอยู่ตอนนี้ — ส่งคำขอได้ ทางร้านจะติดต่อกลับเมื่อเปิด
                      </p>
                    );
                  }
                  return null;
                })()}
              </Field>
              <Field label="ความเร่งด่วน">
                <ChoiceRow
                  value={form.urgency}
                  onChange={(v) => patch({ urgency: v as WizardForm["urgency"] })}
                  options={[
                    { value: "standard", label: "ปกติ" },
                    { value: "urgent", label: "ด่วน (มีค่าบริการเพิ่ม)" },
                  ]}
                />
              </Field>
              <Field label="การรับงาน">
                <ChoiceRow
                  value={form.fulfilment}
                  onChange={(v) =>
                    patch({ fulfilment: v as WizardForm["fulfilment"] })
                  }
                  options={[
                    { value: "in_store", label: "รับที่ร้าน" },
                    { value: "pickup", label: "ให้ไปรับงาน" },
                    { value: "delivery", label: "ส่งกลับถึงที่" },
                  ]}
                />
              </Field>
            </div>
          )}

          {/* ----- Step 3: contact + review ----- */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="ชื่อ">
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="ชื่อ-สกุล"
                    className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
                  />
                </Field>
                <Field label="เบอร์โทร *">
                  <input
                    type="tel"
                    inputMode="tel"
                    value={form.phone}
                    onChange={(e) => patch({ phone: e.target.value })}
                    placeholder="0812345678"
                    className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
                  />
                </Field>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="อีเมล (ถ้ามี)">
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => patch({ email: e.target.value })}
                    placeholder="you@example.com"
                    className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
                  />
                </Field>
                <Field label="ช่องทางติดต่อกลับ">
                  <select
                    value={form.contactMethod}
                    onChange={(e) =>
                      patch({
                        contactMethod: e.target
                          .value as WizardForm["contactMethod"],
                      })
                    }
                    className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
                  >
                    <option value="phone">โทรกลับ</option>
                    <option value="line">LINE OA</option>
                    <option value="email">อีเมล</option>
                    <option value="any">ช่องทางใดก็ได้</option>
                  </select>
                </Field>
              </div>

              {/* Review */}
              <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 text-sm">
                <p className="font-semibold text-gray-900">สรุปคำขอ</p>
                <ul className="mt-1 space-y-0.5 text-gray-600">
                  <li>บริการ: {categoryLabel(form.serviceCategory)}</li>
                  <li>รูปแนบ: {form.photos.length} รูป</li>
                  <li>
                    สาขา:{" "}
                    {branches.find((b) => b.code === form.branchCode)?.label ??
                      "ให้ร้านแนะนำ"}
                  </li>
                  <li>
                    ความเร่งด่วน:{" "}
                    {form.urgency === "urgent" ? "ด่วน" : "ปกติ"}
                  </li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Nav — sticks to the viewport bottom on mobile so the
            primary action is always reachable above the fold. */}
        <div className="mt-4 sticky bottom-0 z-10 -mx-4 flex items-center justify-between gap-3 border-t border-gray-100 bg-white/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 disabled:opacity-40"
          >
            ย้อนกลับ
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
              disabled={!canNext}
              className={`rounded-xl px-6 py-2.5 text-sm font-semibold disabled:opacity-50 ${theme.primaryButtonClass}`}
            >
              ถัดไป
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting || !form.phone.trim()}
              className={`rounded-xl px-6 py-2.5 text-sm font-semibold disabled:opacity-50 ${theme.primaryButtonClass}`}
            >
              {submitting ? "กำลังส่ง..." : "ส่งคำขอ"}
            </button>
          )}
        </div>
        <p className="mt-2 text-[11px] text-gray-500 text-center">
          ส่งได้สูงสุด 5 ครั้ง / ชั่วโมง · แบบร่างถูกบันทึกในเครื่องของคุณ
        </p>
      </section>
    </div>
  );
}

function categoryLabel(code: string): string {
  if (!code) return "ยังไม่ระบุ";
  return SERVICE_CATEGORIES.find((c) => c.code === code)?.labelTh ?? code;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-gray-700 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

function ChoiceRow({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
            value === o.value
              ? "border-green-600 bg-green-600 text-white"
              : "border-gray-200 bg-gray-50 text-gray-700"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SuccessCard({
  result,
}: {
  result: Extract<SubmitResult, { ok: true }>;
}) {
  return (
    <div className="rounded-2xl border border-green-200 bg-green-50 p-6 shadow-sm">
      <p className="text-2xl font-extrabold text-green-900">
        ✓ ส่งคำขอเรียบร้อย
      </p>
      <p className="mt-2 text-sm text-green-900">
        เลขที่คำขอ:{" "}
        <span className="font-mono">
          {result.quoteRequestId.slice(0, 8).toUpperCase()}
        </span>
      </p>
      <ul className="mt-3 list-disc list-inside text-sm text-green-900 space-y-1">
        {result.nextSteps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <a
          href={LINE_URL}
          className="rounded-xl bg-green-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-green-800"
        >
          คุยต่อทาง LINE
        </a>
        <Link
          href="/track"
          className="rounded-xl border border-green-300 bg-white px-5 py-2.5 text-sm font-semibold text-green-700"
        >
          ติดตามงาน
        </Link>
      </div>
    </div>
  );
}
