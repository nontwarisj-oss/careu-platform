"use client";

// /admin/communications/templates — list view of all email/sms/line
// templates. Click into one for edit + version history + test-send.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";

type Template = {
  id: string;
  slug: string;
  name: string;
  subject: string;
  preview_text: string | null;
  body_plain: string;
  body_html: string | null;
  variables: string[];
  channels: string[];
  enabled: boolean;
  current_version: number;
  branch_id: string | null;
  updated_at: string;
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

export default function TemplatesPage() {
  return (
    <RouteGuard page="admin">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/communications/templates", {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        templates?: Template[];
        reason?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `โหลดล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setTemplates(json.templates ?? []);
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
    const slug = window.prompt("slug (a-z, 0-9, _, -):", "")?.trim() ?? "";
    if (!slug) return;
    const name = window.prompt("ชื่อ template:", slug)?.trim() ?? "";
    if (!name) return;
    try {
      const res = await fetch("/api/admin/communications/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          name,
          subject: name,
          previewText: "",
          bodyPlain: "เริ่มต้นข้อความที่นี่...",
          bodyHtml: null,
          variables: [],
          channels: ["sms", "line"],
          enabled: true,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string; id?: string };
      if (!res.ok || !json.ok) {
        window.alert(json.reason ?? `HTTP ${res.status}`);
        return;
      }
      window.location.href = `/admin/communications/templates/${json.id}`;
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Network error");
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
          <span className="text-gray-700 font-medium">Templates</span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-extrabold text-gray-900">
              Email / SMS / LINE templates
            </h1>
            <p className="text-xs text-gray-500">
              Interpolation = <code>{`{{variable_name}}`}</code>. Versions are
              immutable.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleCreate()}
            className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold"
          >
            + Template ใหม่
          </button>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="p-8 text-gray-500">โหลด...</div>
        ) : templates.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
            ยังไม่มี template
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {templates.map((t) => (
              <Link
                key={t.id}
                href={`/admin/communications/templates/${t.id}`}
                className="rounded-2xl border border-gray-200 bg-white hover:border-green-300 hover:shadow-sm transition p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-gray-900 truncate">
                      {t.name}
                    </h3>
                    <code className="text-[10px] text-gray-500">{t.slug}</code>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                      t.enabled
                        ? "border-green-200 bg-green-50 text-green-800"
                        : "border-gray-200 bg-gray-50 text-gray-700"
                    }`}
                  >
                    {t.enabled ? "เปิดใช้" : "ปิดใช้"}
                  </span>
                </div>
                <p className="mt-2 text-xs text-gray-700 line-clamp-2">
                  {t.subject}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {t.channels.map((c) => (
                    <span
                      key={c}
                      className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-700"
                    >
                      {c.toUpperCase()}
                    </span>
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] text-gray-500">
                  <span>v{t.current_version}</span>
                  <span>{fmt(t.updated_at)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
