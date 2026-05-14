"use client";

// /admin/communications/templates/[id] — template editor.
//
// • Edit subject / preview / body_plain / body_html / variables / channels.
// • Live render preview using a dummy context where each variable is "[var]".
// • Test-send to an arbitrary recipient.
// • Version history with one-click restore.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
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
  created_at: string;
};

type Version = {
  id: string;
  version: number;
  name: string;
  subject: string;
  preview_text: string | null;
  body_plain: string;
  body_html: string | null;
  variables: string[];
  channels: string[];
  edited_by: string | null;
  edit_reason: string | null;
  created_at: string;
};

const CHANNELS = ["sms", "line", "email"];

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

// Local render — preview only, doesn't hit the server.
function localRender(
  text: string,
  context: Record<string, string>
): string {
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (full, key) =>
    context[key] !== undefined ? context[key] : full
  );
}

export default function TemplateDetailPage() {
  return (
    <RouteGuard page="admin">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [template, setTemplate] = useState<Template | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Template>>({});

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/admin/communications/templates/${id}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        template?: Template;
        versions?: Version[];
        reason?: string;
      };
      if (!res.ok || !json.ok || !json.template) {
        setError(json.reason ?? `โหลดล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setTemplate(json.template);
      setVersions(json.versions ?? []);
      setDraft({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <div className="p-8 text-gray-500">โหลด...</div>;
  if (error || !template) {
    return (
      <div className="p-8 max-w-md mx-auto">
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? "ไม่พบ template"}
          <div className="mt-3">
            <Link
              href="/admin/communications/templates"
              className="text-green-700 underline"
            >
              กลับไปรายการ
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const merged: Template = { ...template, ...draft };

  // Dummy context for live preview — operator types vars, preview shows
  // them replaced with [var] tokens.
  const previewCtx: Record<string, string> = {};
  (merged.variables ?? []).forEach((v) => (previewCtx[v] = `[${v}]`));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const editReason =
        window.prompt("เหตุผลในการแก้ไข (optional)") ?? null;
      const res = await fetch("/api/admin/communications/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: template.id,
          slug: merged.slug,
          name: merged.name,
          subject: merged.subject,
          previewText: merged.preview_text,
          bodyPlain: merged.body_plain,
          bodyHtml: merged.body_html,
          variables: merged.variables,
          channels: merged.channels,
          enabled: merged.enabled,
          branchId: merged.branch_id,
          editReason,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        version?: number;
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? `บันทึกล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setMessage(`บันทึก v${json.version} แล้ว`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  const handleTestSend = async () => {
    const channel = window.prompt(
      "channel (sms / line / email):",
      template.channels[0] ?? "sms"
    );
    if (!channel) return;
    const to = window.prompt(
      "ปลายทาง (เบอร์โทร / lineUserId / อีเมล):"
    );
    if (!to) return;
    try {
      const res = await fetch(
        `/api/admin/communications/templates/${template.id}/test-send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, to }),
        }
      );
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        provider?: string;
      };
      if (!res.ok || !json.ok) {
        window.alert(`ส่งล้มเหลว: ${json.reason ?? `HTTP ${res.status}`}`);
      } else {
        window.alert(`test send สำเร็จ (provider: ${json.provider ?? "?"})`);
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Network error");
    }
  };

  const handleRestore = async (versionId: string) => {
    if (!window.confirm("Restore เวอร์ชันนี้? เวอร์ชันปัจจุบันจะถูกบันทึกเป็น snapshot ก่อน")) {
      return;
    }
    const reason = window.prompt("เหตุผล (optional)") ?? null;
    try {
      const res = await fetch(
        `/api/admin/communications/templates/${template.id}/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ versionId, reason }),
        }
      );
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        window.alert(`Restore ล้มเหลว: ${json.reason ?? `HTTP ${res.status}`}`);
      } else {
        await load();
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Network error");
    }
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/admin" className="hover:text-green-700">
            Admin
          </Link>
          <span>/</span>
          <Link
            href="/admin/communications/templates"
            className="hover:text-green-700"
          >
            Templates
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium font-mono">
            {merged.slug}
          </span>
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

        <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold text-gray-900">รายละเอียด</h2>
            <span className="text-[10px] text-gray-500">
              v{merged.current_version} · {fmt(merged.updated_at)}
            </span>
          </div>

          <Field
            label="ชื่อ template"
            value={merged.name}
            onChange={(v) => setDraft({ ...draft, name: v })}
          />
          <Field
            label="subject"
            value={merged.subject}
            onChange={(v) => setDraft({ ...draft, subject: v })}
          />
          <Field
            label="preview_text"
            value={merged.preview_text ?? ""}
            onChange={(v) =>
              setDraft({ ...draft, preview_text: v || null })
            }
          />
          <Field
            label="body_plain (สำหรับ SMS / LINE)"
            value={merged.body_plain}
            onChange={(v) => setDraft({ ...draft, body_plain: v })}
            multiline
          />
          <Field
            label="body_html (optional — for email)"
            value={merged.body_html ?? ""}
            onChange={(v) => setDraft({ ...draft, body_html: v || null })}
            multiline
          />

          <div>
            <p className="text-[11px] font-semibold text-gray-700">channels</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {CHANNELS.map((c) => {
                const on = merged.channels.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        channels: on
                          ? merged.channels.filter((ch) => ch !== c)
                          : [...merged.channels, c],
                      })
                    }
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                      on
                        ? "border-green-500 bg-green-50 text-green-800"
                        : "border-gray-200 bg-white text-gray-600"
                    }`}
                  >
                    {c.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-[11px] font-semibold text-gray-700">
              variables (comma-separated)
            </p>
            <input
              type="text"
              value={(merged.variables ?? []).join(", ")}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  variables: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm font-mono"
              placeholder="customer_name, branch_name, job_id"
            />
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-gray-100">
            <label className="flex items-center gap-2 text-sm text-gray-800">
              <input
                type="checkbox"
                checked={merged.enabled}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
                className="h-4 w-4 accent-green-700"
              />
              เปิดใช้งาน
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleTestSend()}
                className="rounded-xl border border-amber-200 bg-amber-50 hover:bg-amber-100 text-amber-900 px-3 py-2 text-xs font-semibold"
              >
                Test send
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving || Object.keys(draft).length === 0}
                className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                {saving ? "บันทึก..." : `บันทึก (สร้าง v${merged.current_version + 1})`}
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
          <h2 className="text-base font-bold text-gray-900">Preview</h2>
          <PreviewBlock
            title="subject"
            text={localRender(merged.subject, previewCtx)}
          />
          {merged.preview_text && (
            <PreviewBlock
              title="preview_text"
              text={localRender(merged.preview_text, previewCtx)}
            />
          )}
          <PreviewBlock
            title="body_plain"
            text={localRender(merged.body_plain, previewCtx)}
          />
          {merged.body_html && (
            <PreviewBlock
              title="body_html"
              text={localRender(merged.body_html, previewCtx)}
            />
          )}
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-bold text-gray-900">
            Version history ({versions.length})
          </h2>
          {versions.length === 0 ? (
            <p className="mt-2 text-xs text-gray-500">
              ยังไม่มีประวัติ — เวอร์ชันแรกถูกบันทึกอัตโนมัติเมื่อแก้ไขครั้งหน้า
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-gray-100">
              {versions.map((v) => (
                <li
                  key={v.id}
                  className="py-2 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-gray-900">
                      v{v.version}
                    </div>
                    <div className="text-[11px] text-gray-500 truncate">
                      {v.subject}
                    </div>
                    {v.edit_reason && (
                      <div className="text-[10px] text-gray-500 italic">
                        {v.edit_reason}
                      </div>
                    )}
                    <div className="text-[10px] text-gray-400">
                      {fmt(v.created_at)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRestore(v.id)}
                    className="rounded-md border border-gray-200 bg-white hover:bg-gray-50 px-2 py-1 text-[10px] font-semibold text-gray-700"
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-gray-700">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500 font-mono"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
        />
      )}
    </label>
  );
}

function PreviewBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-gradient-to-br from-gray-50 to-white p-3">
      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-1">
        {title}
      </p>
      <pre className="whitespace-pre-wrap text-xs text-gray-800 font-sans leading-relaxed">
        {text}
      </pre>
    </div>
  );
}
