"use client";

// /admin/crm/broadcasts — draft list + creation entry point.
//
// Phase 15: drafts only. No send button. Operators iterate on a draft,
// estimate the audience size, and review the template preview. The
// actual mass-send pipeline is deferred to a later phase.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";

type Draft = {
  id: string;
  name: string;
  notes: string | null;
  segment: Record<string, unknown>;
  template_sms: string | null;
  template_line: string | null;
  channels: string[];
  status: "draft" | "preview" | "paused" | "archived";
  branch_id: string | null;
  created_at: string;
  updated_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  draft: "ฉบับร่าง",
  preview: "ดูตัวอย่างแล้ว",
  paused: "พักไว้",
  archived: "เก็บถาวร",
};

const STATUS_TONE: Record<string, string> = {
  draft: "border-yellow-200 bg-yellow-50 text-yellow-800",
  preview: "border-blue-200 bg-blue-50 text-blue-900",
  paused: "border-orange-200 bg-orange-50 text-orange-900",
  archived: "border-gray-200 bg-gray-50 text-gray-600",
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("th-TH", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export default function BroadcastsPage() {
  return (
    <RouteGuard page="admin">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/crm/broadcasts", {
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        setError("ไม่มีสิทธิ์เข้าถึง");
        setDrafts([]);
        return;
      }
      const json = (await res.json()) as {
        ok?: boolean;
        drafts?: Draft[];
        reason?: string;
      };
      if (!json.ok) {
        setError(json.reason ?? `โหลดล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setDrafts(json.drafts ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    const name = window.prompt(
      "ชื่อ broadcast draft (≥ 3 ตัวอักษร)",
      "ใหม่ — " + new Date().toLocaleDateString("th-TH")
    );
    if (!name || name.trim().length < 3) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/crm/broadcasts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          channels: ["sms", "line"],
          segment: {},
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        id?: string;
        reason?: string;
      };
      if (!res.ok || !json.ok) {
        window.alert(`สร้างไม่สำเร็จ: ${json.reason ?? `HTTP ${res.status}`}`);
      } else {
        void load();
      }
    } catch (err) {
      window.alert(
        `สร้างไม่สำเร็จ: ${err instanceof Error ? err.message : "Network error"}`
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">CRM · Broadcasts</span>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold text-gray-900">
              Broadcast drafts
            </h1>
            <p className="text-sm text-gray-600">
              เตรียมข้อความ + audience ก่อนส่งจริง —{" "}
              <strong className="text-gray-800">ยังไม่ส่ง</strong> ในเฟสนี้
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/admin/crm/audiences"
              className="rounded-xl border border-gray-200 bg-white hover:bg-gray-50 px-4 py-2 text-sm font-semibold text-gray-800"
            >
              สร้าง audience
            </Link>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={creating}
              className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              + draft ใหม่
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="rounded-2xl border border-gray-100 bg-white p-8 animate-pulse">
            <div className="h-4 w-1/3 bg-gray-200 rounded" />
            <div className="mt-3 h-12 bg-gray-100 rounded" />
            <div className="mt-2 h-12 bg-gray-100 rounded" />
          </div>
        ) : drafts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-10 text-center">
            <p className="text-sm text-gray-500">
              ยังไม่มี draft — กด &quot;+ draft ใหม่&quot; เพื่อเริ่มต้น
            </p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {drafts.map((d) => (
              <Link
                key={d.id}
                href={`/admin/crm/broadcasts/${d.id}`}
                className="rounded-2xl border border-gray-200 bg-white hover:border-green-300 hover:shadow-sm transition p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-bold text-gray-900 truncate">
                    {d.name}
                  </h3>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                      STATUS_TONE[d.status] ?? STATUS_TONE.draft
                    }`}
                  >
                    {STATUS_LABEL[d.status] ?? d.status}
                  </span>
                </div>
                {d.notes && (
                  <p className="mt-1 text-xs text-gray-600 line-clamp-2">
                    {d.notes}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-1">
                  {d.channels.map((c) => (
                    <span
                      key={c}
                      className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-700"
                    >
                      {c.toUpperCase()}
                    </span>
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-between text-[10px] text-gray-500">
                  <span>{d.branch_id ?? "ทุกสาขา"}</span>
                  <span>{fmt(d.updated_at)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}

        <p className="text-[11px] text-gray-500 text-center">
          การ &quot;ส่งจริง&quot; ยังไม่เปิดในเฟสนี้ — drafts ที่นี่ใช้
          เพื่อเตรียมข้อความ + ตรวจสอบ audience เท่านั้น
        </p>
      </div>
    </div>
  );
}
