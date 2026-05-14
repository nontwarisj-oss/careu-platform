"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { usePortalRefresh } from "@/lib/usePortalRefresh";

type PortalOrderDetail = {
  id: string;
  refId: string;
  jobId: string | null;
  branchLabel: string | null;
  status: string;
  statusLabel: string;
  paymentStatus: string;
  paymentLabel: string;
  service: string;
  templateText: string | null;
  quantity: number;
  price: number;
  subtotal: number | null;
  discount: number;
  urgent: boolean;
  urgentFee: number;
  dueDate: string | null;
  createdAt: string;
};

type TimelineEvent = {
  id: string;
  action: string;
  actionLabel: string;
  from: string | null;
  to: string | null;
  changedAt: string;
};

type PortalPhoto = {
  id: string;
  url: string;
  mime: string | null;
  name: string | null;
  createdAt: string;
};

export default function PortalOrderDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [order, setOrder] = useState<PortalOrderDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [photos, setPhotos] = useState<PortalPhoto[]>([]);
  const [zoomPhoto, setZoomPhoto] = useState<PortalPhoto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    const [orderRes, timelineRes, photosRes] = await Promise.all([
      fetch(`/api/portal/orders/${id}`, { cache: "no-store" }),
      fetch(`/api/portal/orders/${id}/timeline`, { cache: "no-store" }),
      fetch(`/api/portal/orders/${id}/photos`, { cache: "no-store" }),
    ]);
    if (
      orderRes.status === 401 ||
      timelineRes.status === 401 ||
      photosRes.status === 401
    ) {
      router.replace("/portal/signin");
      return;
    }
    const json = (await orderRes.json()) as {
      ok?: boolean;
      order?: PortalOrderDetail;
      reason?: string;
    };
    if (!json.ok || !json.order) {
      setError(json.reason ?? "ไม่พบงาน");
      setLoading(false);
      return;
    }
    setOrder(json.order);
    if (timelineRes.ok) {
      const tj = (await timelineRes.json()) as {
        ok?: boolean;
        events?: TimelineEvent[];
      };
      if (tj.ok && Array.isArray(tj.events)) {
        setTimeline(tj.events);
      }
    }
    if (photosRes.ok) {
      const pj = (await photosRes.json()) as {
        ok?: boolean;
        photos?: PortalPhoto[];
      };
      if (pj.ok && Array.isArray(pj.photos)) {
        setPhotos(pj.photos);
      }
    }
    setLoading(false);
  }, [id, router]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Visibility-aware polling — refresh every 30s while the tab is in
  // the foreground. Pauses entirely when the tab is hidden so a
  // forgotten browser doesn't burn bandwidth all day.
  usePortalRefresh(refresh, { intervalMs: 30_000, fireOnMount: false });

  if (loading) {
    return (
      <div className="rounded-2xl border border-gray-100 bg-white p-8 animate-pulse">
        <div className="h-3 w-24 bg-gray-200 rounded" />
        <div className="mt-3 h-7 w-1/2 bg-gray-200 rounded" />
        <div className="mt-2 h-4 w-1/3 bg-gray-100 rounded" />
        <div className="mt-6 grid sm:grid-cols-2 gap-3">
          <div className="h-20 bg-gray-100 rounded" />
          <div className="h-20 bg-gray-100 rounded" />
        </div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
        {error ?? "ไม่พบงาน"}
        <div className="mt-3">
          <Link href="/portal/orders" className="text-green-700 underline">
            กลับไปหน้างานของฉัน
          </Link>
        </div>
      </div>
    );
  }

  const subtotal = order.subtotal ?? order.price + order.discount - order.urgentFee;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <Link href="/portal/orders" className="hover:text-green-700">
          งานของฉัน
        </Link>
        <span>/</span>
        <span className="text-gray-700 font-medium">
          {order.jobId ?? order.refId}
        </span>
      </div>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <p className="text-[10px] uppercase tracking-widest text-green-700 font-semibold">
          Job {order.jobId ?? order.refId}
        </p>
        <h1 className="mt-1 text-2xl sm:text-3xl font-extrabold text-gray-900">
          {order.service}
        </h1>
        {order.templateText && (
          <p className="mt-1 text-sm text-gray-600">{order.templateText}</p>
        )}
        <p className="mt-2 text-xs text-gray-500">
          {order.branchLabel ?? "ไม่ระบุสาขา"} ·{" "}
          {new Date(order.createdAt).toLocaleString("th-TH", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <Badge label={order.statusLabel} tone={order.status} />
          <Badge label={order.paymentLabel} tone={`pay-${order.paymentStatus}`} />
          {order.urgent && (
            <span className="rounded-full border border-red-200 bg-red-50 text-red-800 px-2.5 py-0.5 text-xs font-semibold">
              งานด่วน
            </span>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-bold text-gray-900">สรุปยอด</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <Row label="ราคารวมก่อนหักส่วนลด" value={`฿${Math.round(subtotal).toLocaleString()}`} />
          {order.urgentFee > 0 && (
            <Row
              label="ค่าด่วน"
              value={`+฿${Math.round(order.urgentFee).toLocaleString()}`}
            />
          )}
          {order.discount > 0 && (
            <Row
              label="ส่วนลด"
              value={`−฿${Math.round(order.discount).toLocaleString()}`}
            />
          )}
          <Row
            label="ยอดสุทธิ"
            value={`฿${Math.round(order.price).toLocaleString()}`}
            bold
          />
        </dl>
        {order.dueDate && (
          <p className="mt-3 text-xs text-gray-500">
            กำหนดรับ:{" "}
            {new Date(order.dueDate).toLocaleDateString("th-TH", {
              dateStyle: "long",
            })}
          </p>
        )}
      </section>

      {photos.length > 0 && (
        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-lg font-bold text-gray-900">รูปประกอบงาน</h2>
          <p className="mt-1 text-[11px] text-gray-500">
            แตะรูปเพื่อขยาย — ลิงก์รูปมีอายุประมาณ 5 นาที
          </p>
          <div className="mt-3 grid grid-cols-3 sm:grid-cols-4 gap-2">
            {photos.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setZoomPhoto(p)}
                className="aspect-square rounded-xl overflow-hidden bg-gray-100 border border-gray-200 hover:border-green-500 focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.url}
                  alt={p.name ?? "รูปงาน"}
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-bold text-gray-900">ประวัติงาน</h2>
        {timeline.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">
            ยังไม่มีประวัติการเปลี่ยนแปลง
          </p>
        ) : (
          <ol className="mt-4 relative border-l-2 border-gray-200 ml-2 space-y-5">
            {timeline.map((ev) => (
              <li key={ev.id} className="pl-5 relative">
                <span
                  className={`absolute -left-[7px] top-1 h-3 w-3 rounded-full border-2 border-white ${dotColor(
                    ev.action,
                    ev.to
                  )}`}
                />
                <div className="text-sm font-semibold text-gray-900">
                  {ev.actionLabel}
                  {ev.to && (
                    <span className="ml-1.5 font-normal text-gray-600">
                      → {ev.to}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-gray-500">
                  {new Date(ev.changedAt).toLocaleString("th-TH", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="text-[11px] text-gray-500 text-center">
        ข้อมูลภายในร้าน (ค่าวัสดุ / ค่าแรงช่าง / โน้ตพนักงาน) ไม่แสดงในพอร์ทัล
      </p>

      {zoomPhoto && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setZoomPhoto(null)}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            onClick={() => setZoomPhoto(null)}
            className="absolute top-4 right-4 rounded-full bg-white/10 hover:bg-white/20 text-white px-3 py-1 text-sm"
            aria-label="ปิด"
          >
            ปิด
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoomPhoto.url}
            alt={zoomPhoto.name ?? "รูปงาน"}
            className="max-w-full max-h-full object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-gray-600">{label}</dt>
      <dd className={bold ? "font-bold text-gray-900" : "text-gray-800"}>
        {value}
      </dd>
    </div>
  );
}

function dotColor(action: string, to: string | null): string {
  if (action === "cancelled") return "bg-red-500";
  if (action === "created") return "bg-green-600";
  if (action === "payment_changed") {
    if (to === "ชำระแล้ว") return "bg-green-600";
    if (to === "มัดจำแล้ว") return "bg-amber-500";
    return "bg-gray-400";
  }
  if (action === "status_changed") {
    if (to === "เสร็จสิ้น") return "bg-green-600";
    if (to === "พร้อมรับ") return "bg-purple-500";
    if (to === "กำลังซ่อม") return "bg-blue-500";
    if (to === "ยกเลิก") return "bg-red-500";
    return "bg-gray-400";
  }
  return "bg-gray-400";
}

function Badge({ label, tone }: { label: string; tone: string }) {
  const colour =
    tone === "ready-for-pickup"
      ? "border-purple-200 bg-purple-50 text-purple-900"
      : tone === "completed"
      ? "border-green-200 bg-green-50 text-green-900"
      : tone === "in-progress"
      ? "border-blue-200 bg-blue-50 text-blue-900"
      : tone === "pay-paid"
      ? "border-green-200 bg-green-50 text-green-900"
      : tone === "pay-deposit"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : tone === "pay-unpaid"
      ? "border-red-200 bg-red-50 text-red-900"
      : "border-yellow-200 bg-yellow-50 text-yellow-900";
  return (
    <span
      className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${colour}`}
    >
      {label}
    </span>
  );
}
