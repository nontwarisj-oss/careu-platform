"use client";

import { useState } from "react";
import { defaultBrandTheme } from "@/lib/publicTheme";

type TrackResult = {
  ok: true;
  jobId: string;
  branchLabel: string | null;
  status: string;
  statusLabel: string;
  paymentStatus: string;
  paymentLabel: string;
  dueDate: string | null;
  createdAt: string | null;
  readyForPickup: boolean;
} | {
  ok: false;
  reason: string;
};

export default function TrackPage() {
  const theme = defaultBrandTheme();
  const [jobId, setJobId] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TrackResult | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/public/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: jobId.trim(), phone: phone.trim() }),
      });
      const json = (await res.json()) as TrackResult;
      setResult(json);
    } catch (err) {
      setResult({
        ok: false,
        reason:
          err instanceof Error ? err.message : "ขัดข้องชั่วคราว — ลองอีกครั้ง",
      });
    }
    setLoading(false);
  };

  return (
    <div>
      <section className={`bg-gradient-to-r ${theme.accentClass} text-white`}>
        <div className="max-w-3xl mx-auto px-4 py-10">
          <h1 className="text-3xl sm:text-4xl font-extrabold">ติดตามงานของฉัน</h1>
          <p className="mt-2 text-sm opacity-90">
            ใส่ Job ID + เบอร์โทรของคุณ ระบบจะแสดงสถานะงานล่าสุด
          </p>
        </div>
      </section>

      <section className="max-w-3xl mx-auto px-4 py-8">
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-gray-200 bg-white p-5 space-y-4 shadow-sm"
        >
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              Job ID
            </label>
            <input
              type="text"
              value={jobId}
              onChange={(e) => setJobId(e.target.value.toUpperCase())}
              required
              autoComplete="off"
              placeholder="เช่น A1B2C3D4 หรือ SLM-260513-001"
              className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500 font-mono"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              ดูจากใบเสร็จที่ทางร้านให้ — เป็นรหัสตัวอักษร / ตัวเลข
            </p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              เบอร์โทร
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              autoComplete="tel"
              inputMode="tel"
              placeholder="0812345678"
              className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              เบอร์ที่ลงทะเบียนกับทางร้าน — ใช้ยืนยันว่าเป็นเจ้าของงาน
            </p>
          </div>
          <button
            type="submit"
            disabled={loading || !jobId.trim() || !phone.trim()}
            className={`w-full rounded-xl px-5 py-3 text-sm font-semibold disabled:opacity-50 ${theme.primaryButtonClass}`}
          >
            {loading ? "กำลังค้นหา..." : "ติดตามงาน"}
          </button>
        </form>

        {result && (
          <div className="mt-5">
            {result.ok ? <SuccessCard result={result} /> : <ErrorCard reason={result.reason} />}
          </div>
        )}
      </section>
    </div>
  );
}

function SuccessCard({
  result,
}: {
  result: Extract<TrackResult, { ok: true }>;
}) {
  return (
    <div className="rounded-2xl border border-green-200 bg-white p-5 shadow-sm">
      <p className="text-xs uppercase tracking-widest text-green-700 font-semibold">
        Job ID
      </p>
      <p className="mt-1 text-2xl font-extrabold text-gray-900 font-mono">
        {result.jobId}
      </p>
      {result.branchLabel && (
        <p className="mt-1 text-sm text-gray-600">สาขา: {result.branchLabel}</p>
      )}
      <div className="mt-4 grid sm:grid-cols-2 gap-3 text-sm">
        <Field label="สถานะงาน" value={result.statusLabel} tone="status" status={result.status} />
        <Field
          label="การชำระเงิน"
          value={result.paymentLabel}
          tone="payment"
          status={result.paymentStatus}
        />
        <Field
          label="กำหนดรับงาน"
          value={
            result.dueDate
              ? new Date(result.dueDate).toLocaleDateString("th-TH", {
                  dateStyle: "long",
                })
              : "—"
          }
        />
        <Field
          label="วันที่รับงานเข้าระบบ"
          value={
            result.createdAt
              ? new Date(result.createdAt).toLocaleDateString("th-TH", {
                  dateStyle: "long",
                })
              : "—"
          }
        />
      </div>
      {result.readyForPickup && (
        <div className="mt-4 rounded-xl border border-purple-200 bg-purple-50 px-4 py-3 text-sm text-purple-900">
          🎉 งานของคุณ <strong>พร้อมรับ</strong> แล้ว — แวะที่สาขาได้เลย
        </div>
      )}
    </div>
  );
}

function ErrorCard({ reason }: { reason: string }) {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
      {reason}
    </div>
  );
}

function Field({
  label,
  value,
  tone,
  status,
}: {
  label: string;
  value: string;
  tone?: "status" | "payment";
  status?: string;
}) {
  const colour =
    tone === "status"
      ? status === "ready-for-pickup"
        ? "border-purple-200 bg-purple-50 text-purple-900"
        : status === "completed"
        ? "border-green-200 bg-green-50 text-green-900"
        : status === "in-progress"
        ? "border-blue-200 bg-blue-50 text-blue-900"
        : "border-yellow-200 bg-yellow-50 text-yellow-900"
      : tone === "payment"
      ? status === "paid"
        ? "border-green-200 bg-green-50 text-green-900"
        : status === "deposit"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-red-200 bg-red-50 text-red-900"
      : "border-gray-200 bg-gray-50 text-gray-800";
  return (
    <div className={`rounded-xl border px-3 py-2 ${colour}`}>
      <p className="text-[10px] uppercase tracking-widest opacity-80">{label}</p>
      <p className="mt-0.5 font-semibold">{value}</p>
    </div>
  );
}
