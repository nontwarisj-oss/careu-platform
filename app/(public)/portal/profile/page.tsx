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
};

export default function PortalProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/portal/profile", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/portal/signin");
        return;
      }
      const json = (await res.json()) as {
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
