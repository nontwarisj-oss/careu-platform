"use client";

import { useEffect, useState } from "react";
import { defaultBrandTheme } from "@/lib/publicTheme";
import { SERVICE_CATEGORIES } from "@/lib/pricing";

type BranchOption = {
  code: string;
  label: string;
  brand: string | null;
};

type SubmitResult =
  | {
      ok: true;
      quoteRequestId: string;
      receivedAt: string;
      nextSteps: string[];
    }
  | { ok: false; reason: string };

const CONTACT_METHODS: Array<{
  value: "phone" | "line" | "email" | "any";
  label: string;
}> = [
  { value: "phone", label: "โทรกลับ" },
  { value: "line", label: "LINE OA" },
  { value: "email", label: "อีเมล" },
  { value: "any", label: "ช่องทางใดก็ได้" },
];

export default function QuotePage() {
  const theme = defaultBrandTheme();
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    branchCode: "",
    serviceCategory: "",
    contactMethod: "phone" as "phone" | "line" | "email" | "any",
    notes: "",
    photos: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);

  // Pre-fill branch from `?branch=` query param when arriving from a
  // branch detail page.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const branch = params.get("branch");
    if (branch) setForm((f) => ({ ...f, branchCode: branch }));
  }, []);

  useEffect(() => {
    void (async () => {
      // Public read of `branches` — the table is intentionally readable by
      // anon (no RLS); the API surface we expose is filtered to is_active.
      const res = await fetch("/api/public/branches-list");
      // The route doesn't exist yet — we render whatever the server returns
      // and gracefully fall back to "—" if empty. Inline list of branches
      // also acceptable; future enhancement is a real endpoint.
      if (!res.ok) {
        setBranches([]);
        return;
      }
      const json = (await res.json()) as {
        ok?: boolean;
        branches?: BranchOption[];
      };
      setBranches(json.branches ?? []);
    })().catch(() => setBranches([]));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    const photos = form.photos
      .split(/\s+|\n+|,+/g)
      .map((u) => u.trim())
      .filter((u) => u.length > 0)
      .slice(0, 10);
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
          photos,
        }),
      });
      const json = (await res.json()) as SubmitResult;
      setResult(json);
      if (json.ok) {
        // Clear form so a confused user doesn't submit twice.
        setForm({
          name: "",
          phone: "",
          email: "",
          branchCode: "",
          serviceCategory: "",
          contactMethod: "phone",
          notes: "",
          photos: "",
        });
      }
    } catch (err) {
      setResult({
        ok: false,
        reason:
          err instanceof Error ? err.message : "ส่งคำขอไม่สำเร็จ — ลองอีกครั้ง",
      });
    }
    setSubmitting(false);
  };

  return (
    <div>
      <section className={`bg-gradient-to-r ${theme.accentClass} text-white`}>
        <div className="max-w-3xl mx-auto px-4 py-10">
          <h1 className="text-3xl sm:text-4xl font-extrabold">ขอใบเสนอราคา</h1>
          <p className="mt-2 text-sm opacity-90 max-w-xl">
            เล่ารายละเอียดงานให้เราฟัง — ทางร้านจะติดต่อกลับภายใน 1 วันทำการ
          </p>
        </div>
      </section>

      <section className="max-w-3xl mx-auto px-4 py-8">
        {result?.ok ? (
          <SuccessCard result={result} />
        ) : (
          <form
            onSubmit={handleSubmit}
            className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm space-y-4"
          >
            {result && !result.ok && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {result.reason}
              </div>
            )}

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  ชื่อ
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="ชื่อ-สกุล"
                  className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  เบอร์โทร *
                </label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  required
                  inputMode="tel"
                  placeholder="0812345678"
                  className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  อีเมล (ถ้ามี)
                </label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="you@example.com"
                  className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  ช่องทางติดต่อกลับ
                </label>
                <select
                  value={form.contactMethod}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      contactMethod: e.target.value as typeof form.contactMethod,
                    })
                  }
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
                >
                  {CONTACT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  สาขาที่ต้องการใช้บริการ
                </label>
                <select
                  value={form.branchCode}
                  onChange={(e) =>
                    setForm({ ...form, branchCode: e.target.value })
                  }
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="">— ให้ทางร้านแนะนำ —</option>
                  {branches.map((b) => (
                    <option key={b.code} value={b.code}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  ประเภทบริการ
                </label>
                <select
                  value={form.serviceCategory}
                  onChange={(e) =>
                    setForm({ ...form, serviceCategory: e.target.value })
                  }
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="">— เลือกประเภท —</option>
                  {SERVICE_CATEGORIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.labelTh}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                รายละเอียดงาน
              </label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={4}
                placeholder="เช่น กางเกงยีนส์ขาดที่หัวเข่า อยากให้ปะ — ไม่อยากให้เห็น"
                className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                ลิงก์รูปภาพ (ถ้ามี)
              </label>
              <textarea
                value={form.photos}
                onChange={(e) => setForm({ ...form, photos: e.target.value })}
                rows={2}
                placeholder="วาง URL รูปคั่นด้วยช่องว่าง / Enter / comma — สูงสุด 10 รูป"
                className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500 font-mono text-sm"
              />
              <p className="mt-1 text-[11px] text-gray-500">
                อัปโหลดผ่านเว็บโดยตรงยังไม่รองรับในเฟสนี้ — ส่งลิงก์รูป
                Imgur / Drive ฯลฯ ได้
              </p>
            </div>

            <button
              type="submit"
              disabled={submitting || !form.phone.trim()}
              className={`w-full rounded-xl px-5 py-3 text-sm font-semibold disabled:opacity-50 ${theme.primaryButtonClass}`}
            >
              {submitting ? "กำลังส่ง..." : "ส่งคำขอใบเสนอราคา"}
            </button>
            <p className="text-[11px] text-gray-500 text-center">
              ส่งได้สูงสุด 5 ครั้ง / ชั่วโมง / IP เพื่อป้องกันการสแปม
            </p>
          </form>
        )}
      </section>
    </div>
  );
}

function SuccessCard({
  result,
}: {
  result: Extract<SubmitResult, { ok: true }>;
}) {
  return (
    <div className="rounded-2xl border border-green-200 bg-green-50 p-5 shadow-sm">
      <p className="text-2xl font-extrabold text-green-900">
        ✓ ส่งคำขอเรียบร้อย
      </p>
      <p className="mt-2 text-sm text-green-900">
        เลขที่คำขอ:{" "}
        <span className="font-mono">{result.quoteRequestId.slice(0, 8).toUpperCase()}</span>
        {" · "}รับเมื่อ{" "}
        {new Date(result.receivedAt).toLocaleString("th-TH", {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      </p>
      <ul className="mt-3 list-disc list-inside text-sm text-green-900 space-y-1">
        {result.nextSteps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ul>
    </div>
  );
}
