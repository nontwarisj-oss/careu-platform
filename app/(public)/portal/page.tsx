"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type PortalMe = {
  ok: true;
  customer: {
    id: string;
    name: string | null;
    phone: string;
    tier: string | null;
    lifecycle: string | null;
    branchId: string | null;
    lastVisitAt: string | null;
    totalOrders: number;
    lifetimeSpend: number;
  };
};

export default function PortalHomePage() {
  const router = useRouter();
  const [me, setMe] = useState<PortalMe["customer"] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/portal/auth/me", { cache: "no-store" });
      const json = (await res.json()) as { ok?: boolean; customer?: PortalMe["customer"] };
      if (!res.ok || !json.ok) {
        router.replace("/portal/signin");
        return;
      }
      setMe(json.customer ?? null);
      setLoading(false);
    })();
  }, [router]);

  const handleSignOut = async () => {
    await fetch("/api/portal/auth/logout", { method: "POST" });
    router.replace("/portal/signin");
  };

  if (loading || !me) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
        กำลังโหลด...
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-green-100 bg-gradient-to-r from-green-700 to-emerald-600 text-white p-5">
        <p className="text-xs uppercase tracking-widest font-semibold opacity-90">
          ยินดีต้อนรับกลับ
        </p>
        <h1 className="mt-1 text-2xl sm:text-3xl font-extrabold">
          {me.name || `คุณลูกค้า · ${me.phone}`}
        </h1>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {me.tier && (
            <span className="rounded-full bg-white/15 px-2 py-0.5">
              tier: {me.tier}
            </span>
          )}
          {me.lifecycle && (
            <span className="rounded-full bg-white/15 px-2 py-0.5">
              {me.lifecycle}
            </span>
          )}
          {me.lastVisitAt && (
            <span className="rounded-full bg-white/15 px-2 py-0.5">
              เข้าใช้ล่าสุด {new Date(me.lastVisitAt).toLocaleDateString("th-TH")}
            </span>
          )}
        </div>
      </section>

      <section className="grid sm:grid-cols-3 gap-3">
        <StatCard label="งานทั้งหมด" value={String(me.totalOrders)} tone="green" />
        <StatCard
          label="ยอดใช้รวม"
          value={`฿${Math.round(me.lifetimeSpend).toLocaleString()}`}
          tone="yellow"
        />
        <StatCard
          label="สาขาหลัก"
          value={me.branchId ?? "—"}
          tone="gray"
        />
      </section>

      <section className="grid sm:grid-cols-2 gap-3">
        <PortalLink
          href="/portal/orders"
          title="ดูงานของฉัน"
          body="งานที่กำลังดำเนินอยู่และประวัติทั้งหมด"
        />
        <PortalLink
          href="/portal/profile"
          title="แก้ไขโปรไฟล์"
          body="อัปเดตชื่อ / อีเมล / ดูข้อมูลสมาชิก"
        />
        <PortalLink
          href="/portal/history"
          title="ประวัติการเข้าใช้"
          body="กิจกรรมที่ผ่านมาในบัญชีของคุณ"
        />
        <PortalLink
          href="/track"
          title="ติดตามงานด้วย Job ID"
          body="ใช้ Job ID + เบอร์โทรในการตรวจสอบเร็ว ๆ"
        />
      </section>

      <div className="text-right">
        <button
          type="button"
          onClick={() => void handleSignOut()}
          className="text-xs text-gray-500 hover:text-red-700"
        >
          ออกจากระบบ
        </button>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "yellow" | "gray";
}) {
  const toneClass = {
    green: "border-green-100 bg-green-50 text-green-900",
    yellow: "border-yellow-100 bg-yellow-50 text-yellow-900",
    gray: "border-gray-100 bg-gray-50 text-gray-800",
  }[tone];
  return (
    <div className={`rounded-2xl border ${toneClass} p-4 shadow-sm`}>
      <p className="text-xs opacity-80">{label}</p>
      <p className="mt-1 text-xl font-bold">{value}</p>
    </div>
  );
}

function PortalLink({
  href,
  title,
  body,
}: {
  href: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="block rounded-2xl border border-gray-200 bg-white p-5 hover:border-green-300 hover:shadow-md transition"
    >
      <h2 className="text-base font-bold text-gray-900">{title}</h2>
      <p className="mt-1 text-sm text-gray-600">{body}</p>
      <p className="mt-2 text-xs font-semibold text-green-700">เปิดดู →</p>
    </Link>
  );
}
