"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { branches as ALL_BRANCHES } from "@/lib/brandConfig";

type Prefs = {
  sms_enabled: boolean;
  line_enabled: boolean;
  email_enabled: boolean;
  pickup_reminders: boolean;
  order_status_alerts: boolean;
  payment_alerts: boolean;
  promotional: boolean;
};

const DEFAULTS: Prefs = {
  sms_enabled: true,
  line_enabled: true,
  email_enabled: false,
  pickup_reminders: true,
  order_status_alerts: true,
  payment_alerts: true,
  promotional: false,
};

export default function PortalPreferencesPage() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/portal/preferences", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/portal/signin?expired=1");
        return;
      }
      const json = (await res.json()) as {
        ok?: boolean;
        prefs?: Prefs & { last_updated_at: string | null };
        reason?: string;
      };
      if (!json.ok || !json.prefs) {
        setError(json.reason ?? "โหลดการตั้งค่าล้มเหลว");
        setLoading(false);
        return;
      }
      const { last_updated_at, ...rest } = json.prefs;
      setPrefs(rest);
      setLastUpdated(last_updated_at);
      setLoading(false);
    })();
  }, [router]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/portal/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefs),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        changesApplied?: number;
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `บันทึกไม่สำเร็จ (HTTP ${res.status})`);
      } else {
        const n = json.changesApplied ?? 0;
        setMessage(
          n > 0
            ? `บันทึก ${n} รายการ — ใช้กับการแจ้งเตือนครั้งต่อไป`
            : "ไม่มีรายการที่เปลี่ยน"
        );
        setLastUpdated(new Date().toISOString());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-gray-100 bg-white p-8 animate-pulse">
        <div className="h-3 w-24 bg-gray-200 rounded" />
        <div className="mt-3 h-6 w-1/2 bg-gray-200 rounded" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-12 bg-gray-100 rounded" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <Link href="/portal/profile" className="hover:text-green-700">
          โปรไฟล์
        </Link>
        <span>/</span>
        <span className="text-gray-700 font-medium">การแจ้งเตือน</span>
      </div>

      <h1 className="text-2xl font-extrabold text-gray-900">การแจ้งเตือน</h1>
      <p className="text-sm text-gray-600">
        เลือกช่องทางและประเภทข้อความที่คุณต้องการรับ
      </p>

      {message && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {message}
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-bold text-gray-900">ช่องทาง</h2>
        <p className="mt-1 text-[11px] text-gray-500">
          ปิดทั้งช่องทาง จะไม่ได้รับแม้เปิดประเภทไว้
        </p>
        <div className="mt-3 space-y-2">
          <Toggle
            label="SMS"
            description="ข้อความสั้นเข้าโทรศัพท์"
            checked={prefs.sms_enabled}
            onChange={(v) => setPrefs({ ...prefs, sms_enabled: v })}
          />
          <Toggle
            label="LINE"
            description="ส่งทาง LINE OA (เฉพาะลูกค้าที่เพิ่มเพื่อน)"
            checked={prefs.line_enabled}
            onChange={(v) => setPrefs({ ...prefs, line_enabled: v })}
          />
          <Toggle
            label="อีเมล"
            description="ยังไม่เปิดบริการ — เร็วๆ นี้"
            checked={prefs.email_enabled}
            onChange={(v) => setPrefs({ ...prefs, email_enabled: v })}
            disabled
          />
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-bold text-gray-900">ประเภทข้อความ</h2>
        <div className="mt-3 space-y-2">
          <Toggle
            label="อัปเดตสถานะงาน"
            description="เริ่มซ่อม / เสร็จสิ้น / ยกเลิก"
            checked={prefs.order_status_alerts}
            onChange={(v) => setPrefs({ ...prefs, order_status_alerts: v })}
          />
          <Toggle
            label="เตือนมารับงาน"
            description="พร้อมรับ + แจ้งเตือนเมื่อยังไม่มารับ"
            checked={prefs.pickup_reminders}
            onChange={(v) => setPrefs({ ...prefs, pickup_reminders: v })}
          />
          <Toggle
            label="การชำระเงิน"
            description="แจ้งใบเสร็จ + รับชำระ"
            checked={prefs.payment_alerts}
            onChange={(v) => setPrefs({ ...prefs, payment_alerts: v })}
          />
          <Toggle
            label="โปรโมชั่น"
            description="ข่าวสาร / ส่วนลด (ค่าเริ่มต้น: ปิด)"
            checked={prefs.promotional}
            onChange={(v) => setPrefs({ ...prefs, promotional: v })}
          />
        </div>
      </section>

      <div className="flex items-center justify-between text-[11px] text-gray-500">
        <span>
          {lastUpdated
            ? `แก้ไขล่าสุด: ${new Date(lastUpdated).toLocaleString("th-TH", {
                dateStyle: "medium",
                timeStyle: "short",
              })}`
            : "ยังไม่เคยแก้ไข — กำลังใช้ค่าเริ่มต้น"}
        </span>
      </div>

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="w-full rounded-xl bg-green-700 hover:bg-green-800 text-white px-5 py-3 text-sm font-semibold disabled:opacity-50"
      >
        {saving ? "กำลังบันทึก..." : "บันทึกการตั้งค่า"}
      </button>

      <p className="text-[10px] text-gray-500 text-center">
        การปิดข้อความสำคัญ (เช่น OTP) ไม่สามารถปิดได้ — ระบบจะส่งเฉพาะเมื่อจำเป็น
      </p>

      <SavedPreferences />
    </div>
  );
}

// ---------- Phase 27A — saved customer preferences --------------------

type SavedPrefs = {
  preferredBranchId: string | null;
  preferredLanguage: string | null;
  preferredContactChannel: string | null;
  preferredPickupTime: string | null;
};

const PICKUP_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "ไม่ระบุ" },
  { value: "morning", label: "ช่วงเช้า (09:00–12:00)" },
  { value: "afternoon", label: "ช่วงบ่าย (12:00–16:00)" },
  { value: "evening", label: "ช่วงเย็น (16:00–19:00)" },
];

function SavedPreferences() {
  const [prefs, setPrefs] = useState<SavedPrefs>({
    preferredBranchId: null,
    preferredLanguage: null,
    preferredContactChannel: null,
    preferredPickupTime: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/portal/profile", { cache: "no-store" });
        if (!res.ok) {
          setLoading(false);
          return;
        }
        const json = (await res.json()) as {
          ok?: boolean;
          profile?: SavedPrefs;
        };
        if (json.ok && json.profile) {
          setPrefs({
            preferredBranchId: json.profile.preferredBranchId ?? null,
            preferredLanguage: json.profile.preferredLanguage ?? null,
            preferredContactChannel:
              json.profile.preferredContactChannel ?? null,
            preferredPickupTime: json.profile.preferredPickupTime ?? null,
          });
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/portal/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferredBranchId: prefs.preferredBranchId,
          preferredLanguage: prefs.preferredLanguage,
          preferredContactChannel: prefs.preferredContactChannel,
          preferredPickupTime: prefs.preferredPickupTime,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `บันทึกไม่สำเร็จ (HTTP ${res.status})`);
      } else {
        setMessage("บันทึกความชอบแล้ว");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section className="rounded-2xl border border-gray-100 bg-white p-5 animate-pulse">
        <div className="h-5 w-1/3 bg-gray-200 rounded" />
        <div className="mt-3 h-10 bg-gray-100 rounded" />
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
      <div>
        <h2 className="text-base font-bold text-gray-900">ความชอบของคุณ</h2>
        <p className="mt-1 text-[11px] text-gray-500">
          ช่วยให้เราเตรียมบริการให้ตรงใจ — เว้นว่างได้ทุกช่อง
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

      <PrefSelect
        label="สาขาที่สะดวก"
        value={prefs.preferredBranchId ?? ""}
        onChange={(v) =>
          setPrefs({ ...prefs, preferredBranchId: v || null })
        }
        options={[
          { value: "", label: "ไม่ระบุ" },
          ...ALL_BRANCHES.map((b) => ({ value: b.id, label: b.shortLabel })),
        ]}
      />
      <PrefSelect
        label="ภาษา"
        value={prefs.preferredLanguage ?? ""}
        onChange={(v) =>
          setPrefs({ ...prefs, preferredLanguage: v || null })
        }
        options={[
          { value: "", label: "ไม่ระบุ" },
          { value: "th", label: "ไทย" },
          { value: "en", label: "English" },
        ]}
      />
      <PrefSelect
        label="ช่องทางติดต่อที่สะดวก"
        value={prefs.preferredContactChannel ?? ""}
        onChange={(v) =>
          setPrefs({ ...prefs, preferredContactChannel: v || null })
        }
        options={[
          { value: "", label: "ไม่ระบุ" },
          { value: "sms", label: "SMS" },
          { value: "line", label: "LINE" },
          { value: "email", label: "อีเมล" },
        ]}
      />
      <PrefSelect
        label="ช่วงเวลารับงานที่สะดวก"
        value={prefs.preferredPickupTime ?? ""}
        onChange={(v) =>
          setPrefs({ ...prefs, preferredPickupTime: v || null })
        }
        options={PICKUP_OPTIONS}
      />

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="w-full rounded-xl bg-green-700 hover:bg-green-800 text-white px-5 py-2.5 text-sm font-semibold disabled:opacity-50"
      >
        {saving ? "กำลังบันทึก..." : "บันทึกความชอบ"}
      </button>
    </section>
  );
}

function PrefSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-gray-700">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-3 rounded-xl border border-gray-100 bg-gray-50 px-3 py-3 cursor-pointer ${
        disabled ? "opacity-50 cursor-not-allowed" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-gray-900">{label}</div>
        <div className="text-[11px] text-gray-500">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
          checked ? "bg-green-600" : "bg-gray-300"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          } self-center`}
        />
      </button>
    </label>
  );
}
