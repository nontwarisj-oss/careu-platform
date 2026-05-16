"use client";

// /admin/settings/branches — Phase 27D franchise public-layer editor.
//
// Owner / HQ manage every branch's public-facing fields here —
// operating hours, promo banner, open/closed override, holidays,
// map + LINE links, hero image — without a code edit. Branches load
// live from the API (never a hardcoded list).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { computeBranchStatus } from "@/lib/branchPublicStatus";

type BranchRow = {
  code: string;
  name: string;
  short_label: string | null;
  is_active: boolean;
  operating_hours: Record<string, string> | null;
  promo_banner: string | null;
  manual_status: "open" | "closed" | null;
  holiday_dates: string[] | null;
  map_url: string | null;
  line_url: string | null;
  hero_image_path: string | null;
};

const DAYS: Array<{ key: string; label: string }> = [
  { key: "mon", label: "จันทร์" },
  { key: "tue", label: "อังคาร" },
  { key: "wed", label: "พุธ" },
  { key: "thu", label: "พฤหัสบดี" },
  { key: "fri", label: "ศุกร์" },
  { key: "sat", label: "เสาร์" },
  { key: "sun", label: "อาทิตย์" },
];

export default function BranchPublicSettingsPage() {
  return (
    <RouteGuard page="admin">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const [rows, setRows] = useState<BranchRow[]>([]);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Draft state for the selected branch.
  const [hours, setHours] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [promo, setPromo] = useState("");
  const [manual, setManual] = useState<"auto" | "open" | "closed">("auto");
  const [holidays, setHolidays] = useState<string[]>([]);
  const [newHoliday, setNewHoliday] = useState("");
  const [mapUrl, setMapUrl] = useState("");
  const [lineUrl, setLineUrl] = useState("");
  const [heroPath, setHeroPath] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/settings/branch-public", {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        branches?: BranchRow[];
        reason?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      setRows(json.branches ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = useMemo(
    () => rows.find((r) => r.code === code) ?? null,
    [rows, code]
  );

  // Sync the draft when the selected branch changes.
  useEffect(() => {
    if (!current) return;
    const h = current.operating_hours ?? {};
    setHours({
      mon: h.mon ?? "",
      tue: h.tue ?? "",
      wed: h.wed ?? "",
      thu: h.thu ?? "",
      fri: h.fri ?? "",
      sat: h.sat ?? "",
      sun: h.sun ?? "",
    });
    setNote(typeof h.note === "string" ? h.note : "");
    setPromo(current.promo_banner ?? "");
    setManual(current.manual_status ?? "auto");
    setHolidays(
      Array.isArray(current.holiday_dates) ? current.holiday_dates : []
    );
    setMapUrl(current.map_url ?? "");
    setLineUrl(current.line_url ?? "");
    setHeroPath(current.hero_image_path ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, rows.length]);

  const save = async () => {
    if (!code) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    // Build operating_hours: only non-empty day windows + note.
    const oh: Record<string, string> = {};
    for (const d of DAYS) {
      if (hours[d.key]?.trim()) oh[d.key] = hours[d.key].trim();
    }
    if (note.trim()) oh.note = note.trim();
    try {
      const res = await fetch("/api/admin/settings/branch-public", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          operatingHours: Object.keys(oh).length > 0 ? oh : null,
          promoBanner: promo || null,
          manualStatus: manual,
          holidayDates: holidays,
          mapUrl: mapUrl || null,
          lineUrl: lineUrl || null,
          heroImagePath: heroPath || null,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      setMessage("บันทึกแล้ว — หน้าเว็บสาธารณะอัปเดตทันที");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  // Live preview of the computed open/closed status.
  const previewStatus = computeBranchStatus({
    manualStatus: manual === "auto" ? null : manual,
    operatingHours: (() => {
      const oh: Record<string, string> = {};
      for (const d of DAYS) if (hours[d.key]?.trim()) oh[d.key] = hours[d.key];
      return oh;
    })(),
    holidayDates: holidays,
  });

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-2xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Branch public settings</span>
        </div>

        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">
            ตั้งค่าหน้าเว็บสาขา
          </h1>
          <p className="text-xs text-gray-500">
            เวลาทำการ · โปรโมชัน · เปิด/ปิด · วันหยุด · ลิงก์แผนที่ + LINE —
            มีผลกับหน้าเว็บสาธารณะทันที
          </p>
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

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <label className="block text-sm font-semibold text-gray-800">
            สาขา
          </label>
          <select
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
          >
            <option value="">-- เลือกสาขา --</option>
            {rows.map((b) => (
              <option key={b.code} value={b.code}>
                {b.short_label ?? b.name}
                {b.is_active ? "" : " (ปิดกิจการ)"}
              </option>
            ))}
          </select>
        </section>

        {loading ? (
          <p className="text-sm text-gray-500">โหลด...</p>
        ) : current ? (
          <>
            {/* Open/closed override + live preview */}
            <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-bold text-gray-900">
                  สถานะเปิด/ปิด
                </h2>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                    previewStatus.status === "open"
                      ? "border-green-300 bg-green-50 text-green-800"
                      : previewStatus.status === "closed"
                        ? "border-red-300 bg-red-50 text-red-800"
                        : "border-gray-300 bg-gray-50 text-gray-600"
                  }`}
                >
                  ตอนนี้: {previewStatus.label}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    { v: "auto", l: "อัตโนมัติ (ตามเวลาทำการ)" },
                    { v: "open", l: "บังคับเปิด" },
                    { v: "closed", l: "บังคับปิด" },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setManual(o.v)}
                    className={`rounded-xl border px-3 py-2 text-sm font-semibold ${
                      manual === o.v
                        ? "border-green-600 bg-green-600 text-white"
                        : "border-gray-200 bg-gray-50 text-gray-700"
                    }`}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
            </section>

            {/* Operating hours */}
            <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-2">
              <h2 className="text-base font-bold text-gray-900">เวลาทำการ</h2>
              <p className="text-[11px] text-gray-500">
                รูปแบบ HH:MM-HH:MM (เช่น 09:00-19:00) — เว้นว่าง = ปิดวันนั้น
              </p>
              {DAYS.map((d) => (
                <div key={d.key} className="flex items-center gap-3">
                  <span className="w-20 text-sm text-gray-700">{d.label}</span>
                  <input
                    type="text"
                    value={hours[d.key] ?? ""}
                    onChange={(e) =>
                      setHours({ ...hours, [d.key]: e.target.value })
                    }
                    placeholder="09:00-19:00"
                    className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
                  />
                </div>
              ))}
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="หมายเหตุ (เช่น หยุดวันหยุดนักขัตฤกษ์)"
                className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              />
            </section>

            {/* Holidays */}
            <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-2">
              <h2 className="text-base font-bold text-gray-900">วันหยุดพิเศษ</h2>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={newHoliday}
                  onChange={(e) => setNewHoliday(e.target.value)}
                  className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (newHoliday && !holidays.includes(newHoliday)) {
                      setHolidays([...holidays, newHoliday].sort());
                      setNewHoliday("");
                    }
                  }}
                  className="rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 text-sm font-semibold text-green-800"
                >
                  เพิ่ม
                </button>
              </div>
              {holidays.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {holidays.map((h) => (
                    <span
                      key={h}
                      className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-700"
                    >
                      {h}
                      <button
                        type="button"
                        onClick={() =>
                          setHolidays(holidays.filter((x) => x !== h))
                        }
                        className="text-red-600 font-bold"
                        aria-label="ลบ"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-400">ยังไม่มีวันหยุดพิเศษ</p>
              )}
            </section>

            {/* Public links + branding */}
            <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
              <h2 className="text-base font-bold text-gray-900">
                ลิงก์ + แบรนด์
              </h2>
              <TextField
                label="โปรโมชัน (แบนเนอร์บนหน้าสาขา)"
                value={promo}
                onChange={setPromo}
                placeholder="เช่น ลด 10% เดือนนี้"
              />
              <TextField
                label="ลิงก์แผนที่ (เว้นว่าง = สร้างจากที่อยู่อัตโนมัติ)"
                value={mapUrl}
                onChange={setMapUrl}
                placeholder="https://maps.google.com/..."
              />
              <TextField
                label="ลิงก์ LINE ของสาขา"
                value={lineUrl}
                onChange={setLineUrl}
                placeholder="https://lin.ee/..."
              />
              <TextField
                label="รูป hero (path ใน /public)"
                value={heroPath}
                onChange={setHeroPath}
                placeholder="/heroes/c24.jpg"
              />
            </section>

            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="w-full rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-3 text-sm font-semibold disabled:opacity-50"
            >
              {saving ? "กำลังบันทึก..." : "บันทึกการตั้งค่าสาขา"}
            </button>
          </>
        ) : (
          <p className="text-sm text-gray-500">เลือกสาขาเพื่อเริ่มแก้ไข</p>
        )}
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-gray-700">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
      />
    </label>
  );
}
