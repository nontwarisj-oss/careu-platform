"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Profile = {
  id: string;
  name: string;
  phone: string;
  email: string;
  tier: string | null;
  lifecycle: string | null;
  branchId: string | null;
  lastVisitAt: string | null;
  totalOrders: number;
  lifetimeSpend: number;
  birthDate: string | null;
  birthMonthVerified: boolean;
};

type ActivityEvent = {
  id: string;
  kind: string;
  label: string;
  timestamp: string;
  source: "activity" | "notification";
  detail: string | null;
};

export default function PortalProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [profileRes, activityRes] = await Promise.all([
        fetch("/api/portal/profile", { cache: "no-store" }),
        fetch("/api/portal/activity?limit=20", { cache: "no-store" }),
      ]);
      if (profileRes.status === 401 || activityRes.status === 401) {
        router.replace("/portal/signin");
        return;
      }
      const json = (await profileRes.json()) as {
        ok?: boolean;
        profile?: Profile;
        reason?: string;
      };
      if (!json.ok || !json.profile) {
        setError(json.reason ?? "ดึงโปรไฟล์ไม่สำเร็จ");
        setLoading(false);
        return;
      }
      setProfile(json.profile);
      setName(json.profile.name);
      setEmail(json.profile.email);
      if (activityRes.ok) {
        const aj = (await activityRes.json()) as {
          ok?: boolean;
          events?: ActivityEvent[];
        };
        if (aj.ok && Array.isArray(aj.events)) {
          setActivity(aj.events);
        }
      }
      setLoading(false);
    })();
  }, [router]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/portal/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `บันทึกไม่สำเร็จ (HTTP ${res.status})`);
      } else {
        setMessage("บันทึกเรียบร้อย");
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
        <div className="mt-4 h-12 bg-gray-100 rounded" />
        <div className="mt-3 h-12 bg-gray-100 rounded" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
        {error ?? "ไม่พบโปรไฟล์"}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold text-gray-900">โปรไฟล์</h1>

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

      <form
        onSubmit={handleSave}
        className="rounded-2xl border border-gray-200 bg-white p-5 space-y-4 shadow-sm"
      >
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            ชื่อ-สกุล
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ชื่อ-สกุล"
            className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            เบอร์โทร (อ่านอย่างเดียว)
          </label>
          <input
            type="text"
            value={profile.phone}
            readOnly
            disabled
            className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-base text-gray-700"
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <p className="text-[11px] text-gray-500">
              เปลี่ยนเบอร์ต้องยืนยันเบอร์ใหม่ด้วย OTP
            </p>
            <a
              href="/portal/phone-change"
              className="text-[11px] text-green-700 font-semibold hover:text-green-900"
            >
              เปลี่ยนเบอร์ →
            </a>
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            อีเมล (ถ้ามี)
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>
        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-xl bg-green-700 hover:bg-green-800 text-white px-5 py-3 text-sm font-semibold disabled:opacity-50"
        >
          {saving ? "กำลังบันทึก..." : "บันทึกการเปลี่ยนแปลง"}
        </button>
      </form>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-gray-900">การแจ้งเตือน</h2>
            <p className="mt-0.5 text-[11px] text-gray-500">
              จัดการช่องทางและประเภทข้อความที่จะรับ
            </p>
          </div>
          <a
            href="/portal/preferences"
            className="rounded-xl border border-green-200 bg-green-50 hover:bg-green-100 text-green-800 px-3 py-2 text-xs font-semibold whitespace-nowrap"
          >
            ตั้งค่า →
          </a>
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-bold text-gray-900">ข้อมูลสมาชิก</h2>
        <dl className="mt-3 grid sm:grid-cols-2 gap-3 text-sm">
          <Field label="Tier" value={profile.tier ?? "—"} />
          <Field label="Lifecycle" value={profile.lifecycle ?? "—"} />
          <Field
            label="ยอดงานทั้งหมด"
            value={String(profile.totalOrders)}
          />
          <Field
            label="ยอดใช้รวม"
            value={`฿${Math.round(profile.lifetimeSpend).toLocaleString()}`}
          />
          <Field
            label="เข้าใช้ล่าสุด"
            value={
              profile.lastVisitAt
                ? new Date(profile.lastVisitAt).toLocaleDateString("th-TH")
                : "—"
            }
          />
          <Field label="สาขาหลัก" value={profile.branchId ?? "—"} />
        </dl>
      </section>

      <DobSection
        currentBirthDate={profile.birthDate}
        currentVerified={profile.birthMonthVerified}
        onSaved={(b, v) =>
          setProfile({
            ...profile,
            birthDate: b,
            birthMonthVerified: v,
          })
        }
      />

      <BranchUnsubscribeSection />

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-bold text-gray-900">กิจกรรมล่าสุด</h2>
        <p className="mt-1 text-[11px] text-gray-500">
          แสดง 20 รายการล่าสุด (ใน 90 วัน)
        </p>
        {activity.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">
            ยังไม่มีกิจกรรม — มาเริ่มต้นกับเราด้วยการส่งงานสักรายการสิ
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100">
            {activity.map((ev) => (
              <li key={ev.id} className="py-2.5 flex items-start gap-3">
                <span
                  className={`mt-1 inline-block h-2 w-2 rounded-full flex-shrink-0 ${
                    ev.source === "notification"
                      ? "bg-blue-400"
                      : "bg-green-500"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-gray-900">
                      {ev.label}
                    </span>
                    <span className="text-[10px] text-gray-500 whitespace-nowrap">
                      {new Date(ev.timestamp).toLocaleString("th-TH", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </span>
                  </div>
                  {ev.detail && (
                    <div className="text-[11px] text-gray-600">{ev.detail}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
      <dt className="text-[10px] uppercase tracking-widest text-gray-500">
        {label}
      </dt>
      <dd className="mt-0.5 font-semibold text-gray-900">{value}</dd>
    </div>
  );
}

function DobSection({
  currentBirthDate,
  currentVerified,
  onSaved,
}: {
  currentBirthDate: string | null;
  currentVerified: boolean;
  onSaved: (birthDate: string | null, verified: boolean) => void;
}) {
  const [dob, setDob] = useState(currentBirthDate ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch("/api/portal/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ birthDate: dob || null }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setErr(json.reason ?? `บันทึกไม่สำเร็จ (HTTP ${res.status})`);
      } else {
        setMsg(dob ? "บันทึกวันเกิดเรียบร้อย" : "ลบวันเกิดเรียบร้อย");
        onSaved(dob || null, !!dob);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
      <div>
        <h2 className="text-base font-bold text-gray-900">วันเกิด (ทางเลือก)</h2>
        <p className="mt-0.5 text-[11px] text-gray-500">
          ใส่เพื่อรับโปรช่วงเดือนเกิด — เก็บแค่เดือนพอ (ใส่ปีอะไรก็ได้)
        </p>
      </div>
      {msg && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
          {msg}
        </div>
      )}
      {err && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {err}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type="date"
          value={dob}
          onChange={(e) => setDob(e.target.value)}
          className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 whitespace-nowrap"
        >
          {saving ? "..." : "บันทึก"}
        </button>
      </div>
      {currentBirthDate && (
        <p className="text-[10px] text-gray-500">
          ตั้งค่าแล้ว · ได้รับสิทธิ์เดือนเกิด:{" "}
          {currentVerified ? "เปิด" : "ปิด"}
        </p>
      )}
    </section>
  );
}

function BranchUnsubscribeSection() {
  type Row = {
    id: string;
    branch_id: string;
    channel: string;
    scope: string;
    reason: string | null;
    unsubscribed_at: string;
  };
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await fetch("/api/portal/unsubscribe", { cache: "no-store" });
      const json = (await res.json()) as { ok?: boolean; rows?: Row[] };
      if (json.ok) setRows(json.rows ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleResubscribe = async (id: string) => {
    if (!window.confirm("เลิกการเลิกรับข้อความจากสาขานี้?")) return;
    try {
      const res = await fetch(
        `/api/portal/unsubscribe?id=${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      if (res.ok) void load();
    } catch {}
  };

  if (loading) return null;
  if (rows.length === 0) return null;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <h2 className="text-base font-bold text-gray-900">
        การเลิกรับข้อความเฉพาะสาขา
      </h2>
      <p className="mt-0.5 text-[11px] text-gray-500">
        คุณได้เลิกรับข้อความจากสาขาเหล่านี้
      </p>
      <ul className="mt-3 divide-y divide-gray-100">
        {rows.map((r) => (
          <li
            key={r.id}
            className="py-2 flex items-center justify-between gap-2"
          >
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900">
                {r.branch_id}
              </div>
              <div className="text-[10px] text-gray-500">
                {r.channel.toUpperCase()} · {r.scope}{" "}
                {r.reason && `· ${r.reason}`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleResubscribe(r.id)}
              className="rounded-md border border-green-200 bg-green-50 hover:bg-green-100 text-green-800 px-2 py-1 text-[10px] font-semibold"
            >
              re-subscribe
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
