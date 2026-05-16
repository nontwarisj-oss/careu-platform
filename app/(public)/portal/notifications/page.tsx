"use client";

// /portal/notifications — Phase 27A customer notification centre.
// Read/unread state, per-channel filter chips, delivery status, and
// a "mark all read" action. Mobile-first card list.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type PortalNotification = {
  id: string;
  channel: string;
  kind: string;
  title: string;
  body: string | null;
  status: string;
  statusLabel: string;
  createdAt: string;
  sentAt: string | null;
  read: boolean;
};

const CHANNEL_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "ทั้งหมด" },
  { value: "sms", label: "SMS" },
  { value: "line", label: "LINE" },
  { value: "email", label: "อีเมล" },
];

const CHANNEL_ICON: Record<string, string> = {
  sms: "💬",
  line: "🟢",
  email: "✉️",
  in_app: "🔔",
};

const STATUS_TONE: Record<string, string> = {
  delivered: "text-green-700",
  sent: "text-green-700",
  failed: "text-red-700",
  dead_letter: "text-red-700",
  queued: "text-gray-500",
  sending: "text-blue-700",
  skipped: "text-gray-400",
};

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("th-TH", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export default function PortalNotificationsPage() {
  const router = useRouter();
  const [items, setItems] = useState<PortalNotification[]>([]);
  const [channel, setChannel] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (ch: string) => {
      setLoading(true);
      const res = await fetch(
        `/api/portal/notifications${ch ? `?channel=${ch}` : ""}`,
        { cache: "no-store" }
      );
      if (res.status === 401) {
        router.replace("/portal/signin?expired=1");
        return;
      }
      const json = (await res.json()) as {
        ok?: boolean;
        notifications?: PortalNotification[];
        reason?: string;
      };
      if (!json.ok) {
        setError(json.reason ?? `โหลดไม่สำเร็จ (HTTP ${res.status})`);
        setLoading(false);
        return;
      }
      setItems(json.notifications ?? []);
      setError(null);
      setLoading(false);
    },
    [router]
  );

  useEffect(() => {
    void load(channel);
  }, [load, channel]);

  const unread = useMemo(() => items.filter((n) => !n.read).length, [items]);

  const markRead = async (id?: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/portal/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark-read", id }),
      });
      if (res.ok) {
        setItems((prev) =>
          prev.map((n) => (!id || n.id === id ? { ...n, read: true } : n))
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-extrabold text-gray-900">การแจ้งเตือน</h1>
        {unread > 0 && (
          <button
            type="button"
            onClick={() => void markRead()}
            disabled={busy}
            className="rounded-xl border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-semibold text-green-800 disabled:opacity-50"
          >
            อ่านทั้งหมด ({unread})
          </button>
        )}
      </div>

      {/* Channel filter chips */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {CHANNEL_FILTERS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setChannel(c.value)}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition ${
              channel === c.value
                ? "border-green-600 bg-green-600 text-white"
                : "border-gray-200 bg-gray-50 text-gray-700"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {loading ? (
        <ul className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <li
              key={i}
              className="rounded-2xl border border-gray-100 bg-white p-4 animate-pulse"
            >
              <div className="h-4 w-2/5 bg-gray-200 rounded" />
              <div className="mt-2 h-3 w-3/5 bg-gray-100 rounded" />
            </li>
          ))}
        </ul>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          {error}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          ยังไม่มีการแจ้งเตือน
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li
              key={n.id}
              className={`rounded-2xl border p-4 transition ${
                n.read
                  ? "border-gray-200 bg-white"
                  : "border-green-300 bg-green-50/60"
              }`}
            >
              <div className="flex items-start gap-3">
                <span className="text-lg leading-none">
                  {CHANNEL_ICON[n.channel] ?? "🔔"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-bold text-gray-900 truncate">
                      {n.title}
                    </p>
                    {!n.read && (
                      <span className="shrink-0 h-2 w-2 rounded-full bg-green-600" />
                    )}
                  </div>
                  {n.body && (
                    <p className="mt-0.5 text-sm text-gray-600 break-words">
                      {n.body}
                    </p>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                    <span className="text-gray-400">{fmt(n.createdAt)}</span>
                    <span
                      className={STATUS_TONE[n.status] ?? "text-gray-500"}
                    >
                      {n.statusLabel}
                    </span>
                    {!n.read && (
                      <button
                        type="button"
                        onClick={() => void markRead(n.id)}
                        disabled={busy}
                        className="font-semibold text-green-700 underline"
                      >
                        ทำเครื่องหมายว่าอ่านแล้ว
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="text-center">
        <Link href="/portal" className="text-sm text-green-700 underline">
          กลับหน้าหลัก
        </Link>
      </p>
    </div>
  );
}
