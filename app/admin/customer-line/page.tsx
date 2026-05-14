"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { Modal } from "@/components/Modal";
import supabase from "@/lib/supabase";
import { useLanguage } from "@/lib/languageContext";
import { useRole } from "@/lib/roleContext";
import { canManageStaff } from "@/lib/permissions";
import {
  fetchLinkedLinks,
  fetchRecentFollowEvents,
  fetchUnmatchedLinks,
  linkLineUserToCustomer,
  markLineLinkIgnored,
  unlinkLineUser,
  type CustomerLineLinkWithStats,
  type FollowEventRow,
} from "@/lib/customerLinker";
import {
  suggestLikelyCustomerMatches,
  type CustomerCandidate,
} from "@/lib/customerMatching";

type Tab = "unmatched" | "linked";

export default function CustomerLinkerPage() {
  // Branch-manager doesn't have admin page key; only owner/hq_admin reach
  // this route through RouteGuard + the API enforces the same.
  return (
    <RouteGuard page="admin">
      <CustomerLinkerInner />
    </RouteGuard>
  );
}

function CustomerLinkerInner() {
  const { language } = useLanguage();
  const { role } = useRole();
  const canEdit = canManageStaff(role);

  const [tab, setTab] = useState<Tab>("unmatched");
  const [unmatched, setUnmatched] = useState<CustomerLineLinkWithStats[]>([]);
  const [linked, setLinked] = useState<CustomerLineLinkWithStats[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Per-row mutation in-flight tracker.
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // Active link the admin is reviewing in the side panel.
  const [active, setActive] = useState<CustomerLineLinkWithStats | null>(null);
  const [activeEvents, setActiveEvents] = useState<FollowEventRow[]>([]);
  const [suggestions, setSuggestions] = useState<CustomerCandidate[]>([]);
  const [phoneHint, setPhoneHint] = useState("");
  const [nameHint, setNameHint] = useState("");
  const [isSearching, setIsSearching] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const [un, ln] = await Promise.all([
      fetchUnmatchedLinks({ limit: 100 }),
      fetchLinkedLinks({ limit: 100 }),
    ]);
    setUnmatched(un);
    setLinked(ln);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({
      unmatched: unmatched.length,
      linked: linked.length,
    }),
    [unmatched, linked]
  );

  const openReview = async (link: CustomerLineLinkWithStats) => {
    setActive(link);
    setPhoneHint("");
    setNameHint(link.display_name ?? "");
    setSuggestions([]);
    setActiveEvents([]);
    const [events, suggested] = await Promise.all([
      fetchRecentFollowEvents(link.line_user_id, 10),
      suggestLikelyCustomerMatches({
        client: supabase,
        displayName: link.display_name,
      }),
    ]);
    setActiveEvents(events);
    setSuggestions(suggested);
  };

  const refreshSuggestions = async () => {
    if (!active) return;
    setIsSearching(true);
    const list = await suggestLikelyCustomerMatches({
      client: supabase,
      displayName: nameHint.trim() || active.display_name,
      phoneHint: phoneHint.trim() || null,
    });
    setSuggestions(list);
    setIsSearching(false);
  };

  const handleLink = async (link: CustomerLineLinkWithStats, customerId: string) => {
    if (!canEdit) return;
    setBusy((prev) => new Set(prev).add(link.id));
    setMessage(null);
    const res = await linkLineUserToCustomer(link.id, customerId);
    setBusy((prev) => {
      const next = new Set(prev);
      next.delete(link.id);
      return next;
    });
    if (!res.ok) {
      setError(res.reason);
      return;
    }
    setMessage(
      language === "th"
        ? "ผูก LINE user กับลูกค้าเรียบร้อย"
        : "Linked successfully"
    );
    setActive(null);
    await load();
  };

  const handleUnlink = async (link: CustomerLineLinkWithStats) => {
    if (!canEdit) return;
    if (
      !window.confirm(
        language === "th"
          ? `ยกเลิกการผูก LINE user "${link.line_user_id.slice(0, 12)}…" หรือไม่? LINE user จะกลับไปอยู่ใน "ยังไม่จับคู่"`
          : `Unlink LINE user "${link.line_user_id.slice(0, 12)}…"? It will move back to "Unmatched".`
      )
    )
      return;
    setBusy((prev) => new Set(prev).add(link.id));
    const res = await unlinkLineUser(link.id);
    setBusy((prev) => {
      const next = new Set(prev);
      next.delete(link.id);
      return next;
    });
    if (!res.ok) {
      setError(res.reason);
      return;
    }
    setMessage(language === "th" ? "ยกเลิกการผูกเรียบร้อย" : "Unlinked");
    await load();
  };

  const handleIgnore = async (link: CustomerLineLinkWithStats) => {
    if (!canEdit) return;
    setBusy((prev) => new Set(prev).add(link.id));
    const res = await markLineLinkIgnored(link.id);
    setBusy((prev) => {
      const next = new Set(prev);
      next.delete(link.id);
      return next;
    });
    if (!res.ok) {
      setError(res.reason);
      return;
    }
    setMessage(language === "th" ? "ทำเครื่องหมายข้าม" : "Marked ignored");
    setActive(null);
    await load();
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-4 flex items-center gap-2 text-xs text-gray-500">
        <Link href="/admin" className="hover:text-green-700">
          {language === "th" ? "ศูนย์จัดการระบบ" : "Admin centre"}
        </Link>
        <span>/</span>
        <span className="text-gray-700 font-medium">
          {language === "th" ? "ผูก LINE ↔ ลูกค้า" : "Customer ↔ LINE linker"}
        </span>
      </div>

      <div className="mb-5 flex flex-col gap-2 border-l-4 border-yellow-400 pl-4">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
          CareU OPS
        </p>
        <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
          {language === "th" ? "ผูกลูกค้ากับ LINE" : "Customer ↔ LINE linker"}
        </h1>
        <p className="text-sm text-gray-600">
          {language === "th"
            ? "จัดการ customer_line_links ที่ยังไม่ระบุลูกค้า — เพื่อให้ระบบส่งข้อความหาลูกค้าได้ถูกต้อง"
            : "Manage customer_line_links rows that have no matched customer yet — so LINE notifications reach the right person."}
        </p>
      </div>

      {/* Summary chips */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <SummaryCard
          label={language === "th" ? "ยังไม่จับคู่" : "Unmatched"}
          value={counts.unmatched}
          tone="yellow"
        />
        <SummaryCard
          label={language === "th" ? "ผูกแล้ว" : "Linked"}
          value={counts.linked}
          tone="green"
        />
      </div>

      {message && (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 flex items-start justify-between gap-3">
          <span>{message}</span>
          <button
            onClick={() => setMessage(null)}
            className="text-green-700 hover:text-green-900"
          >
            ✕
          </button>
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-700 hover:text-red-900"
          >
            ✕
          </button>
        </div>
      )}

      <div className="mb-4 flex gap-2 overflow-x-auto -mx-1 px-1 pb-1">
        <TabButton active={tab === "unmatched"} onClick={() => setTab("unmatched")}>
          {language === "th"
            ? `ยังไม่จับคู่ (${counts.unmatched})`
            : `Unmatched (${counts.unmatched})`}
        </TabButton>
        <TabButton active={tab === "linked"} onClick={() => setTab("linked")}>
          {language === "th"
            ? `ผูกแล้ว (${counts.linked})`
            : `Linked (${counts.linked})`}
        </TabButton>
      </div>

      <LinkTable
        rows={tab === "unmatched" ? unmatched : linked}
        loading={isLoading}
        language={language}
        showCustomer={tab === "linked"}
        busy={busy}
        canEdit={canEdit}
        onReview={openReview}
        onUnlink={handleUnlink}
        onIgnore={handleIgnore}
      />

      {active && (
        <Modal
          isOpen={!!active}
          onClose={() => setActive(null)}
          size="lg"
          hideFooter
          title={
            language === "th"
              ? `LINE user · ${active.line_user_id.slice(0, 12)}…`
              : `LINE user · ${active.line_user_id.slice(0, 12)}…`
          }
        >
          <div className="space-y-4 text-sm">
            <ReviewHeader link={active} language={language} />

            <fieldset className="rounded-xl border border-gray-200 p-3 space-y-2">
              <legend className="px-1 text-[11px] uppercase tracking-widest text-gray-500">
                {language === "th" ? "เหตุการณ์ล่าสุด" : "Recent events"}
              </legend>
              {activeEvents.length === 0 ? (
                <p className="text-xs text-gray-500">
                  {language === "th"
                    ? "ยังไม่มีเหตุการณ์ในระบบ"
                    : "No events captured yet"}
                </p>
              ) : (
                <ul className="text-xs space-y-1">
                  {activeEvents.map((ev) => (
                    <li
                      key={ev.id}
                      className="flex items-center justify-between gap-3 border-b border-gray-100 pb-1 last:border-0 last:pb-0"
                    >
                      <span>
                        <span className="font-mono mr-2">{ev.event_type}</span>
                        {ev.signature_verified ? (
                          <span className="px-1.5 py-0.5 rounded-full border border-green-200 bg-green-50 text-green-800 text-[10px]">
                            verified
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded-full border border-yellow-200 bg-yellow-50 text-yellow-800 text-[10px]">
                            unverified
                          </span>
                        )}
                      </span>
                      <span className="text-gray-500">
                        {new Date(ev.received_at).toLocaleString("th-TH", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>

            <fieldset className="rounded-xl border border-blue-200 p-3 space-y-3">
              <legend className="px-1 text-[11px] uppercase tracking-widest text-blue-700">
                {language === "th" ? "ค้นหาลูกค้าเพื่อผูก" : "Search to link"}
              </legend>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="tel"
                  value={phoneHint}
                  onChange={(e) => setPhoneHint(e.target.value)}
                  placeholder={
                    language === "th"
                      ? "เบอร์โทร (เช่น 0812345678)"
                      : "Phone (e.g. 0812345678)"
                  }
                  className="rounded-xl border border-gray-200 px-3 py-2 outline-none focus:ring-2 focus:ring-green-500"
                />
                <input
                  type="text"
                  value={nameHint}
                  onChange={(e) => setNameHint(e.target.value)}
                  placeholder={language === "th" ? "ชื่อลูกค้า" : "Customer name"}
                  className="rounded-xl border border-gray-200 px-3 py-2 outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <button
                type="button"
                onClick={() => void refreshSuggestions()}
                disabled={isSearching}
                className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-60"
              >
                {isSearching
                  ? language === "th"
                    ? "กำลังค้นหา..."
                    : "Searching..."
                  : language === "th"
                  ? "ค้นหา"
                  : "Search"}
              </button>

              {suggestions.length === 0 ? (
                <p className="text-xs text-gray-500">
                  {language === "th"
                    ? "ยังไม่พบลูกค้าที่ใกล้เคียง — ลองพิมพ์เบอร์โทรหรือชื่อ"
                    : "No candidates yet — try typing a phone or name."}
                </p>
              ) : (
                <ul className="space-y-2 max-h-72 overflow-auto">
                  {suggestions.map((c) => (
                    <li
                      key={c.id}
                      className="rounded-lg border border-gray-200 bg-white p-2 flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 truncate">
                          {c.name}
                        </p>
                        <p className="text-[11px] text-gray-600 truncate">
                          {c.phone ?? "—"} · {c.branch_id ?? "no branch"} ·{" "}
                          {c.matchReason}
                          {c.latestOrderAt
                            ? ` · last order ${new Date(
                                c.latestOrderAt
                              ).toLocaleDateString("th-TH")}`
                            : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleLink(active, c.id)}
                        disabled={!canEdit || busy.has(active.id)}
                        className="px-2.5 py-1 rounded-md border border-green-300 bg-white text-[11px] font-semibold text-green-700 hover:bg-green-50 disabled:opacity-50 shrink-0"
                      >
                        {language === "th"
                          ? `ผูก (${c.score})`
                          : `Link (${c.score})`}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>

            <div className="flex justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={() => void handleIgnore(active)}
                disabled={!canEdit || busy.has(active.id)}
                className="px-4 py-2 rounded-xl border border-yellow-300 bg-white text-yellow-800 text-sm hover:bg-yellow-50 disabled:opacity-50"
              >
                {language === "th"
                  ? "ทำเครื่องหมายข้าม"
                  : "Mark ignored"}
              </button>
              <button
                type="button"
                onClick={() => setActive(null)}
                className="px-4 py-2 rounded-xl border border-gray-200 bg-white text-sm hover:bg-gray-50"
              >
                {language === "th" ? "ปิด" : "Close"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- Sub-components ------------------------------------------------

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "yellow" | "green";
}) {
  const toneClass = {
    yellow: "border-yellow-100 bg-yellow-50 text-yellow-900",
    green: "border-green-100 bg-green-50 text-green-900",
  }[tone];
  return (
    <div className={`rounded-2xl border ${toneClass} p-4 shadow-sm`}>
      <p className="text-xs opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 px-4 py-2 rounded-full text-sm font-medium border transition min-h-[40px] ${
        active
          ? "bg-green-700 border-green-700 text-white"
          : "bg-white border-gray-200 text-gray-700 hover:bg-green-50"
      }`}
    >
      {children}
    </button>
  );
}

function ReviewHeader({
  link,
  language,
}: {
  link: CustomerLineLinkWithStats;
  language: "th" | "en";
}) {
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 text-xs">
      <p>
        <span className="text-gray-500">
          {language === "th" ? "ชื่อใน LINE: " : "Display name: "}
        </span>
        <span className="font-semibold text-gray-900">
          {link.display_name ?? (language === "th" ? "— ไม่มี" : "— none")}
        </span>
      </p>
      <p>
        <span className="text-gray-500">
          {language === "th" ? "ลูกค้าที่ผูก: " : "Linked customer: "}
        </span>
        <span className="font-semibold text-gray-900">
          {link.customerName ?? (link.customer_id ? link.customer_id : "—")}
        </span>
      </p>
      <p>
        <span className="text-gray-500">
          {language === "th" ? "Consented: " : "Consented: "}
        </span>
        {link.consented_at ? new Date(link.consented_at).toLocaleString("th-TH") : "—"}
        {" · "}
        <span className="text-gray-500">
          {language === "th" ? "Unsubscribed: " : "Unsubscribed: "}
        </span>
        {link.unsubscribed_at
          ? new Date(link.unsubscribed_at).toLocaleString("th-TH")
          : "—"}
      </p>
    </div>
  );
}

function LinkTable({
  rows,
  loading,
  language,
  showCustomer,
  busy,
  canEdit,
  onReview,
  onUnlink,
  onIgnore,
}: {
  rows: CustomerLineLinkWithStats[];
  loading: boolean;
  language: "th" | "en";
  showCustomer: boolean;
  busy: Set<string>;
  canEdit: boolean;
  onReview: (link: CustomerLineLinkWithStats) => void;
  onUnlink: (link: CustomerLineLinkWithStats) => void;
  onIgnore: (link: CustomerLineLinkWithStats) => void;
}) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
      {loading ? (
        <div className="p-8 text-center text-gray-500">
          {language === "th" ? "กำลังโหลด..." : "Loading..."}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-gray-500">
          {language === "th"
            ? showCustomer
              ? "ยังไม่มีลูกค้าที่ผูก LINE — รอ webhook ทำงานหรือผูกผ่านแท็บ \"ยังไม่จับคู่\""
              : "ไม่มีรายการที่ยังไม่จับคู่ — ทุก LINE follower ถูกจัดการแล้ว"
            : showCustomer
            ? "No linked customers yet."
            : "No unmatched rows — all LINE followers are sorted."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="text-left p-3">
                  {language === "th" ? "LINE user" : "LINE user"}
                </th>
                <th className="text-left p-3">
                  {language === "th" ? "ชื่อแสดง" : "Display name"}
                </th>
                {showCustomer && (
                  <th className="text-left p-3">
                    {language === "th" ? "ลูกค้า" : "Customer"}
                  </th>
                )}
                <th className="text-left p-3">
                  {language === "th" ? "Consent" : "Consent"}
                </th>
                <th className="text-left p-3">
                  {language === "th" ? "Events" : "Events"}
                </th>
                <th className="text-right p-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((link) => {
                const isBusy = busy.has(link.id);
                return (
                  <tr
                    key={link.id}
                    className="border-t border-gray-100 align-top hover:bg-green-50/30"
                  >
                    <td className="p-3 font-mono text-[11px] text-gray-700 break-all">
                      {link.line_user_id.slice(0, 14)}…
                    </td>
                    <td className="p-3 text-gray-900">
                      {link.display_name ?? "—"}
                    </td>
                    {showCustomer && (
                      <td className="p-3 text-gray-700">
                        {link.customerName ?? link.customer_id ?? "—"}
                      </td>
                    )}
                    <td className="p-3 text-[12px] text-gray-700">
                      {link.consented_at
                        ? new Date(link.consented_at).toLocaleDateString("th-TH")
                        : "—"}
                      {link.unsubscribed_at && (
                        <span className="block text-[10px] text-red-700">
                          {language === "th" ? "ยกเลิก: " : "Unsub: "}
                          {new Date(link.unsubscribed_at).toLocaleDateString("th-TH")}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-[12px] text-gray-700">
                      {link.eventCount ?? 0}
                      {link.latestEventType && (
                        <span className="block text-[10px] text-gray-500">
                          {link.latestEventType} ·{" "}
                          {link.latestEventAt
                            ? new Date(link.latestEventAt).toLocaleDateString("th-TH")
                            : "?"}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-right whitespace-nowrap space-x-1">
                      <button
                        type="button"
                        onClick={() => onReview(link)}
                        className="px-2 py-1 rounded-md border border-green-300 bg-white text-[11px] font-semibold text-green-700 hover:bg-green-50"
                      >
                        {showCustomer
                          ? language === "th"
                            ? "ดู"
                            : "Review"
                          : language === "th"
                          ? "จับคู่"
                          : "Match"}
                      </button>
                      {showCustomer ? (
                        <button
                          type="button"
                          onClick={() => onUnlink(link)}
                          disabled={!canEdit || isBusy}
                          className="px-2 py-1 rounded-md border border-red-200 bg-white text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          {language === "th" ? "ถอนการผูก" : "Unlink"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onIgnore(link)}
                          disabled={!canEdit || isBusy}
                          className="px-2 py-1 rounded-md border border-yellow-300 bg-white text-[11px] font-medium text-yellow-800 hover:bg-yellow-50 disabled:opacity-50"
                        >
                          {language === "th" ? "ข้าม" : "Ignore"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
