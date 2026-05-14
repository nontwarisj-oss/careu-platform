"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";
import { Modal } from "@/components/Modal";
import { useLanguage } from "@/lib/languageContext";
import { useRole } from "@/lib/roleContext";
import { useBranch } from "@/lib/branchContext";
import { canSeeFinancials, canViewAllBranches } from "@/lib/permissions";
import { fetchBranchOptions, type BranchOption } from "@/lib/staffService";
import {
  bulkResolveSyncFailures,
  countDeadFailures,
  fetchLastWorkerRun,
  listFailedSyncs,
  listLineMessageLog,
  rebuildReceiptData,
  resendLineMessage,
  resolveSyncFailure,
  resyncOrderToSheet,
  runRetryWorker,
  type LineMessageLogRow,
  type RetryTickResult,
  type SyncFailureRow,
  type WorkerRunRow,
} from "@/lib/recoveryService";
import { RETRY_POLICIES, type RetryPolicy } from "@/lib/retryPolicy";
import type { ReceiptData } from "@/lib/receiptData";

type Tab = "sync" | "line" | "receipt";

type SyncStatusFilter = "all" | SyncFailureRow["status"];
type SyncKindFilter = "all" | string;
type LineStatusFilter = "all" | LineMessageLogRow["status"];

const SYNC_KIND_LABELS: Record<string, { th: string; en: string }> = {
  order_to_sheet: { th: "ออเดอร์ → Google Sheet", en: "Order → Google Sheet" },
  pricing_to_sheet: { th: "ราคา → Google Sheet", en: "Pricing → Google Sheet" },
  debug_to_sheet: { th: "ดีบัก → Google Sheet", en: "Debug → Google Sheet" },
  customer_from_sheet: {
    th: "ลูกค้า ← Google Sheet",
    en: "Customer ← Google Sheet",
  },
  expense_from_sheet: {
    th: "ค่าใช้จ่าย ← Google Sheet",
    en: "Expense ← Google Sheet",
  },
  line_send: { th: "LINE OA push", en: "LINE OA push" },
  receipt_rebuild: { th: "สร้างใบเสร็จใหม่", en: "Receipt rebuild" },
};

const LINE_KIND_LABELS: Record<LineMessageLogRow["kind"], { th: string; en: string }> = {
  order_received: { th: "รับงาน", en: "Order received" },
  order_ready: { th: "พร้อมรับ", en: "Order ready" },
  pickup_reminder: { th: "เตือนมารับ", en: "Pickup reminder" },
  receipt: { th: "ใบเสร็จ", en: "Receipt" },
  manual: { th: "ส่งเอง", en: "Manual" },
  test: { th: "ทดสอบ", en: "Test" },
};

const SYNC_STATUS_TONE: Record<SyncFailureRow["status"], string> = {
  pending: "border-yellow-200 bg-yellow-50 text-yellow-800",
  retrying: "border-blue-200 bg-blue-50 text-blue-800",
  resolved: "border-green-200 bg-green-50 text-green-800",
  dead: "border-red-200 bg-red-50 text-red-800",
};

const LINE_STATUS_TONE: Record<LineMessageLogRow["status"], string> = {
  pending: "border-yellow-200 bg-yellow-50 text-yellow-800",
  sent: "border-green-200 bg-green-50 text-green-800",
  failed: "border-red-200 bg-red-50 text-red-800",
  skipped: "border-gray-200 bg-gray-50 text-gray-700",
};

function fmtDate(iso: string | null | undefined): string {
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

export default function RecoveryPage() {
  // "recovery" page key is granted to owner / hq_admin (via "*") and
  // explicitly to branch_manager. front_staff / technician are denied.
  return (
    <RouteGuard page="recovery">
      <RecoveryInner />
    </RouteGuard>
  );
}

function RecoveryInner() {
  const { language } = useLanguage();
  const { role } = useRole();
  const { branch } = useBranch();

  // canSeeFinancials = owner / hq_admin / branch_manager — the three roles
  // that ROLE_MATRIX says can recover failures. Front staff / technician
  // are filtered out by RouteGuard above (admin page key not granted to
  // them) but we also gate retry buttons defensively.
  const canRetry = canSeeFinancials(role);
  const seesAllBranches = canViewAllBranches(role);

  const [tab, setTab] = useState<Tab>("sync");
  const [syncRows, setSyncRows] = useState<SyncFailureRow[]>([]);
  const [lineRows, setLineRows] = useState<LineMessageLogRow[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Filters
  const [syncStatusFilter, setSyncStatusFilter] = useState<SyncStatusFilter>("pending");
  const [syncKindFilter, setSyncKindFilter] = useState<SyncKindFilter>("all");
  const [lineStatusFilter, setLineStatusFilter] = useState<LineStatusFilter>("failed");
  const [branchFilter, setBranchFilter] = useState<string>("all");

  // In-flight retry trackers — prevent double-clicks on the same row.
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [resolving, setResolving] = useState<Set<string>>(new Set());

  // Bulk selection for the sync_failures tab. Set of failure ids.
  const [selectedSyncIds, setSelectedSyncIds] = useState<Set<string>>(new Set());

  // Confirmation modal for destructive-ish bulk actions.
  const [confirmAction, setConfirmAction] = useState<
    | {
        kind: "bulk-resolve";
        ids: string[];
      }
    | {
        kind: "run-worker";
        limit: number;
      }
    | null
  >(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [workerSummary, setWorkerSummary] = useState<RetryTickResult | null>(null);

  // Inspection modal
  const [inspect, setInspect] = useState<
    | { kind: "sync"; row: SyncFailureRow }
    | { kind: "line"; row: LineMessageLogRow }
    | null
  >(null);

  // Receipt rebuild state
  const [rebuildOrderId, setRebuildOrderId] = useState("");
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuiltReceipt, setRebuiltReceipt] = useState<ReceiptData | null>(null);
  const [rebuildError, setRebuildError] = useState<string | null>(null);

  // Auto-retry visibility — last cron run, last manual run, dead count.
  const [lastCronRun, setLastCronRun] = useState<WorkerRunRow | null>(null);
  const [lastManualRun, setLastManualRun] = useState<WorkerRunRow | null>(null);
  const [deadCount, setDeadCount] = useState(0);

  const load = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    const branchCode =
      branchFilter === "all"
        ? null
        : branches.find((b) => b.id === branchFilter)?.code ?? null;
    const [syncResult, lineResult, cron, manualNonCron, deads] =
      await Promise.all([
        listFailedSyncs({
          status: syncStatusFilter === "all" ? undefined : syncStatusFilter,
          kind: syncKindFilter === "all" ? undefined : syncKindFilter,
          branchCode,
          limit: 100,
        }),
        listLineMessageLog({
          status: lineStatusFilter === "all" ? undefined : lineStatusFilter,
          branchCode,
          limit: 100,
        }),
        fetchLastWorkerRun({ workerKind: "retry_tick", actorId: "cron" }),
        fetchLastWorkerRun({ workerKind: "retry_tick" }),
        countDeadFailures(branchCode),
      ]);
    setSyncRows(syncResult);
    setLineRows(lineResult);
    setLastCronRun(cron);
    // "Last manual run" = the most recent worker_run whose actor isn't 'cron'.
    // We don't have an easy DB-side `actor_id != 'cron'` shortcut without
    // touching the service layer, so just pick the latest tick and
    // disambiguate client-side.
    setLastManualRun(
      manualNonCron && manualNonCron.actor_id !== "cron" ? manualNonCron : null
    );
    setDeadCount(deads);
    setIsLoading(false);
  }, [syncStatusFilter, syncKindFilter, lineStatusFilter, branchFilter, branches]);

  // One-shot branch options load.
  useEffect(() => {
    void (async () => {
      const opts = await fetchBranchOptions();
      setBranches(opts);
    })();
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const syncSummary = useMemo(() => {
    const byStatus = syncRows.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<SyncFailureRow["status"], number>
    );
    return {
      pending: byStatus.pending ?? 0,
      retrying: byStatus.retrying ?? 0,
      resolved: byStatus.resolved ?? 0,
      dead: byStatus.dead ?? 0,
    };
  }, [syncRows]);

  const lineSummary = useMemo(() => {
    const byStatus = lineRows.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<LineMessageLogRow["status"], number>
    );
    return {
      failed: byStatus.failed ?? 0,
      skipped: byStatus.skipped ?? 0,
      sent: byStatus.sent ?? 0,
    };
  }, [lineRows]);

  const handleRetrySync = async (row: SyncFailureRow) => {
    if (!canRetry) return;
    if (!row.target_id) {
      setMessage(
        language === "th"
          ? "รายการนี้ไม่มี target_id — retry อัตโนมัติทำไม่ได้"
          : "Row has no target_id — automatic retry unavailable."
      );
      return;
    }
    setRetrying((prev) => new Set(prev).add(row.id));
    setMessage(null);

    if (row.kind === "order_to_sheet") {
      const res = await resyncOrderToSheet(row.target_id);
      setMessage(
        res.ok
          ? language === "th"
            ? `ซิงค์สำเร็จ — เพิ่มแถวที่ ${res.rowIndex ?? "?"} ในแท็บ ${res.sheet ?? "Front_Desk"}`
            : `Resynced — row ${res.rowIndex ?? "?"} in ${res.sheet ?? "Front_Desk"}`
          : `${language === "th" ? "Retry ไม่สำเร็จ" : "Retry failed"}: ${res.reason}`
      );
      if (res.ok) {
        await resolveSyncFailure(row.id, "auto-resolved after successful retry");
      }
    } else if (row.kind === "line_send") {
      const payloadKind =
        ((row.payload as { messageKind?: LineMessageLogRow["kind"] } | null)
          ?.messageKind ?? "receipt") as LineMessageLogRow["kind"];
      const res = await resendLineMessage(row.target_id, payloadKind);
      setMessage(
        res.ok
          ? language === "th"
            ? `ส่ง LINE ใหม่สำเร็จ (status=${res.status})`
            : `LINE re-sent (status=${res.status})`
          : `${language === "th" ? "ส่ง LINE ใหม่ไม่สำเร็จ" : "LINE resend failed"}: ${res.reason}`
      );
      if (res.ok) {
        await resolveSyncFailure(row.id, "auto-resolved after successful resend");
      }
    } else {
      setMessage(
        language === "th"
          ? `ยังไม่รองรับ retry อัตโนมัติสำหรับชนิด "${row.kind}" — กด "ทำเสร็จด้วยตนเอง" หลังจัดการแล้ว`
          : `Auto-retry not yet supported for kind "${row.kind}". Mark resolved after a manual fix.`
      );
    }
    setRetrying((prev) => {
      const next = new Set(prev);
      next.delete(row.id);
      return next;
    });
    await load();
  };

  const handleResolve = async (failureId: string) => {
    if (!canRetry) return;
    setResolving((prev) => new Set(prev).add(failureId));
    setMessage(null);
    const res = await resolveSyncFailure(failureId);
    setMessage(
      res.ok
        ? language === "th"
          ? "ทำเครื่องหมายว่าจัดการเรียบร้อย"
          : "Marked resolved"
        : res.reason
    );
    setResolving((prev) => {
      const next = new Set(prev);
      next.delete(failureId);
      return next;
    });
    if (res.ok) await load();
  };

  const handleResendLine = async (row: LineMessageLogRow) => {
    if (!canRetry || !row.order_id) return;
    setRetrying((prev) => new Set(prev).add(row.id));
    setMessage(null);
    const res = await resendLineMessage(row.order_id, row.kind);
    setMessage(
      res.ok
        ? language === "th"
          ? `ส่ง LINE ใหม่สำเร็จ (${LINE_KIND_LABELS[row.kind].th})`
          : `LINE re-sent (${LINE_KIND_LABELS[row.kind].en})`
        : `${language === "th" ? "ส่งใหม่ไม่สำเร็จ" : "Resend failed"}: ${res.reason}`
    );
    setRetrying((prev) => {
      const next = new Set(prev);
      next.delete(row.id);
      return next;
    });
    await load();
  };

  // Reset bulk selection whenever the visible result set changes — keeps
  // selection from referring to rows that filtered out.
  useEffect(() => {
    setSelectedSyncIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(syncRows.map((r) => r.id));
      const next = new Set<string>();
      for (const id of prev) if (visible.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [syncRows]);

  const toggleSelectAllVisible = (visible: SyncFailureRow[]) => {
    const eligible = visible.filter((r) => r.status !== "resolved");
    const allSelected =
      eligible.length > 0 &&
      eligible.every((r) => selectedSyncIds.has(r.id));
    if (allSelected) {
      setSelectedSyncIds(new Set());
    } else {
      setSelectedSyncIds(new Set(eligible.map((r) => r.id)));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedSyncIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runBulkResolve = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBulkRunning(true);
    setMessage(null);
    const res = await bulkResolveSyncFailures(ids);
    if (res.ok) {
      setMessage(
        language === "th"
          ? `ทำเครื่องหมายว่าจัดการเรียบร้อย ${res.resolved} รายการ • ข้าม ${res.skipped}`
          : `Marked ${res.resolved} resolved • skipped ${res.skipped}`
      );
      setSelectedSyncIds(new Set());
      await load();
    } else {
      setMessage(
        language === "th"
          ? `Bulk resolve ไม่สำเร็จ: ${res.reason}`
          : `Bulk resolve failed: ${res.reason}`
      );
    }
    setBulkRunning(false);
  };

  const runWorker = async (limit: number) => {
    setBulkRunning(true);
    setMessage(null);
    setWorkerSummary(null);
    const branchCode =
      branchFilter === "all"
        ? null
        : branches.find((b) => b.id === branchFilter)?.code ?? null;
    const res = await runRetryWorker({
      limit,
      branchCode,
    });
    if (res.ok) {
      setWorkerSummary(res);
      setMessage(
        language === "th"
          ? `Worker ทำงานเสร็จ — สำเร็จ ${res.succeeded} • ล้มเหลว ${res.failed} • ตาย ${res.dead} • ข้าม ${res.skipped} (ทั้งหมด ${res.processed})`
          : `Worker done — succeeded ${res.succeeded} • failed ${res.failed} • dead ${res.dead} • skipped ${res.skipped} (processed ${res.processed})`
      );
      await load();
    } else {
      setMessage(
        language === "th"
          ? `Worker ไม่สำเร็จ: ${res.reason}`
          : `Worker failed: ${res.reason}`
      );
    }
    setBulkRunning(false);
  };

  const handleRebuildReceipt = async () => {
    const id = rebuildOrderId.trim();
    if (!id) return;
    setRebuilding(true);
    setRebuildError(null);
    setRebuiltReceipt(null);
    try {
      const data = await rebuildReceiptData(id);
      if (!data) {
        setRebuildError(
          language === "th"
            ? "ไม่พบใบงาน — หรือ RLS ป้องกันการอ่าน"
            : "Order not found — or RLS denied the read."
        );
      } else {
        setRebuiltReceipt(data);
      }
    } catch (err) {
      setRebuildError(err instanceof Error ? err.message : "Unknown error");
    }
    setRebuilding(false);
  };

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mb-4 flex items-center gap-2 text-xs text-gray-500">
        <Link href="/admin" className="hover:text-green-700">
          {language === "th" ? "ศูนย์จัดการระบบ" : "Admin centre"}
        </Link>
        <span>/</span>
        <span className="text-gray-700 font-medium">
          {language === "th" ? "ระบบกู้คืน" : "Recovery"}
        </span>
      </div>

      <div className="mb-5 flex flex-col gap-2 border-l-4 border-yellow-400 pl-4">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
          CareU OPS
        </p>
        <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
          {language === "th" ? "ระบบกู้คืนการทำงาน" : "Operational recovery"}
        </h1>
        <p className="text-sm text-gray-600">
          {language === "th"
            ? "ดูคิวความล้มเหลว ทดลองส่งซ้ำ และสร้างใบเสร็จใหม่ — สำหรับ Owner / HQ Admin / Branch Manager"
            : "Review failure queues, retry sends, and rebuild receipts — Owner / HQ Admin / Branch Manager."}
        </p>
        <p className="text-[11px] text-gray-500">
          {seesAllBranches
            ? language === "th"
              ? "เห็นข้อมูลทุกสาขา"
              : "Seeing all branches"
            : language === "th"
            ? `เห็นเฉพาะสาขา ${branch.shortLabel}`
            : `Scoped to ${branch.shortLabel}`}
        </p>
      </div>

      {/* Summary chips */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <SummaryCard
          label={language === "th" ? "Sync รอจัดการ" : "Sync pending"}
          value={syncSummary.pending}
          tone="yellow"
        />
        <SummaryCard
          label={language === "th" ? "Sync ตายแล้ว" : "Sync dead"}
          value={syncSummary.dead}
          tone="red"
        />
        <SummaryCard
          label={language === "th" ? "LINE ล้มเหลว" : "LINE failed"}
          value={lineSummary.failed}
          tone="red"
        />
        <SummaryCard
          label={language === "th" ? "LINE ข้าม" : "LINE skipped"}
          value={lineSummary.skipped}
          tone="gray"
        />
      </div>

      <AutoRetryPanel
        language={language}
        lastCronRun={lastCronRun}
        lastManualRun={lastManualRun}
        deadCount={deadCount}
      />

      {message && (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 flex items-start justify-between gap-3">
          <span>{message}</span>
          <button
            onClick={() => setMessage(null)}
            className="text-green-700 hover:text-green-900"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {errorMessage && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {/* Tabs */}
      <div className="mb-4 flex gap-2 overflow-x-auto -mx-1 px-1 pb-1">
        <TabButton active={tab === "sync"} onClick={() => setTab("sync")}>
          {language === "th" ? "Google Sheet / sync_failures" : "Sync failures"}
        </TabButton>
        <TabButton active={tab === "line"} onClick={() => setTab("line")}>
          {language === "th" ? "LINE OA delivery" : "LINE delivery"}
        </TabButton>
        <TabButton active={tab === "receipt"} onClick={() => setTab("receipt")}>
          {language === "th" ? "สร้างใบเสร็จใหม่" : "Receipt rebuild"}
        </TabButton>
      </div>

      {/* Filters bar — common to sync + line tabs */}
      {tab !== "receipt" && (
        <div className="grid gap-2 sm:grid-cols-4 mb-4">
          {tab === "sync" ? (
            <>
              <select
                value={syncStatusFilter}
                onChange={(e) =>
                  setSyncStatusFilter(e.target.value as SyncStatusFilter)
                }
                className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="all">{language === "th" ? "ทุกสถานะ" : "All statuses"}</option>
                <option value="pending">pending</option>
                <option value="retrying">retrying</option>
                <option value="resolved">resolved</option>
                <option value="dead">dead</option>
              </select>
              <select
                value={syncKindFilter}
                onChange={(e) => setSyncKindFilter(e.target.value as SyncKindFilter)}
                className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="all">{language === "th" ? "ทุกชนิด" : "All kinds"}</option>
                {Object.entries(SYNC_KIND_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {language === "th" ? v.th : v.en}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <select
              value={lineStatusFilter}
              onChange={(e) =>
                setLineStatusFilter(e.target.value as LineStatusFilter)
              }
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500 sm:col-span-2"
            >
              <option value="all">{language === "th" ? "ทุกสถานะ" : "All statuses"}</option>
              <option value="failed">failed</option>
              <option value="skipped">skipped</option>
              <option value="sent">sent</option>
              <option value="pending">pending</option>
            </select>
          )}
          {seesAllBranches && (
            <select
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="all">{language === "th" ? "ทุกสาขา" : "All branches"}</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.shortCode ? `${b.shortCode} • ` : ""}
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-xl border border-green-300 bg-white px-3 py-2 text-sm font-semibold text-green-800 hover:bg-green-50"
          >
            {language === "th" ? "รีเฟรช" : "Refresh"}
          </button>
        </div>
      )}

      {/* Tab content */}
      {tab === "sync" && (
        <>
          <BulkActionBar
            language={language}
            canRetry={canRetry}
            selectedCount={selectedSyncIds.size}
            pendingCount={
              syncRows.filter(
                (r) => r.status === "pending" || r.status === "retrying"
              ).length
            }
            bulkRunning={bulkRunning}
            onBulkResolve={() =>
              setConfirmAction({
                kind: "bulk-resolve",
                ids: Array.from(selectedSyncIds),
              })
            }
            onRunWorker={() =>
              setConfirmAction({ kind: "run-worker", limit: 25 })
            }
            onClearSelection={() => setSelectedSyncIds(new Set())}
          />
          {workerSummary && (
            <WorkerSummary
              language={language}
              result={workerSummary}
              onDismiss={() => setWorkerSummary(null)}
            />
          )}
          <SyncFailuresTable
            rows={syncRows}
            isLoading={isLoading}
            canRetry={canRetry}
            retrying={retrying}
            resolving={resolving}
            selectedIds={selectedSyncIds}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={() => toggleSelectAllVisible(syncRows)}
            onRetry={handleRetrySync}
            onResolve={handleResolve}
            onInspect={(row) => setInspect({ kind: "sync", row })}
            language={language}
          />
        </>
      )}
      {tab === "line" && (
        <LineLogTable
          rows={lineRows}
          isLoading={isLoading}
          canRetry={canRetry}
          retrying={retrying}
          onResend={handleResendLine}
          onInspect={(row) => setInspect({ kind: "line", row })}
          language={language}
        />
      )}
      {tab === "receipt" && (
        <ReceiptRebuildPanel
          orderId={rebuildOrderId}
          onChange={setRebuildOrderId}
          onRebuild={handleRebuildReceipt}
          loading={rebuilding}
          error={rebuildError}
          receipt={rebuiltReceipt}
          language={language}
        />
      )}

      {inspect && (
        <Modal
          isOpen={!!inspect}
          onClose={() => setInspect(null)}
          size="lg"
          hideFooter
          title={
            inspect.kind === "sync"
              ? language === "th"
                ? "รายละเอียดความล้มเหลว"
                : "Sync failure detail"
              : language === "th"
              ? "รายละเอียด LINE log"
              : "LINE log detail"
          }
        >
          <pre className="text-[11px] bg-gray-50 border border-gray-200 rounded-lg p-3 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words">
            {JSON.stringify(inspect.row, null, 2)}
          </pre>
        </Modal>
      )}

      {confirmAction && (
        <Modal
          isOpen={!!confirmAction}
          onClose={() => setConfirmAction(null)}
          size="md"
          hideFooter
          title={
            confirmAction.kind === "bulk-resolve"
              ? language === "th"
                ? "ยืนยันการทำเครื่องหมายว่าจัดการ"
                : "Confirm bulk resolve"
              : language === "th"
              ? "ยืนยันรัน worker"
              : "Confirm run worker"
          }
        >
          <div className="space-y-3 text-sm">
            {confirmAction.kind === "bulk-resolve" ? (
              <>
                <p>
                  {language === "th"
                    ? `จะทำเครื่องหมาย ${confirmAction.ids.length} รายการเป็น "resolved" — การกระทำนี้ไม่ทำให้ Google Sheet หรือ LINE ส่งงานใหม่ มันแค่ปิดคิวว่าจัดการเองแล้ว`
                    : `Mark ${confirmAction.ids.length} rows as resolved. Does NOT trigger any retry — it just closes the queue entry so you can move on.`}
                </p>
                <p className="text-[11px] text-gray-500">
                  {language === "th"
                    ? "ทุกแถวที่เลือกจะได้ payload.bulkActionId เดียวกันเพื่อให้ค้นย้อนหลังได้"
                    : "Every selected row is stamped with the same bulkActionId so you can find them later."}
                </p>
              </>
            ) : (
              <>
                <p>
                  {language === "th"
                    ? `จะดึง ${confirmAction.limit} รายการแรกที่ "pending" และให้ worker ลองส่งใหม่ — รายการที่ลองเสร็จไม่นาน (60 วินาที) จะถูกข้าม`
                    : `Will pick up to ${confirmAction.limit} pending rows and dispatch retries. Rows attempted in the last 60s are skipped by the cooldown.`}
                </p>
                <p className="text-[11px] text-gray-500">
                  {language === "th"
                    ? "Worker จะทำงานครั้งเดียว ไม่มีลูปอัตโนมัติ — สามารถกดซ้ำได้หลังจากดูผลลัพธ์"
                    : "Single tick only — no auto-loop. You can press again after reviewing the summary."}
                </p>
              </>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2 rounded-xl border border-gray-200 bg-white text-sm hover:bg-gray-50"
              >
                {language === "th" ? "ยกเลิก" : "Cancel"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirmAction.kind === "bulk-resolve") {
                    void runBulkResolve(confirmAction.ids);
                  } else {
                    void runWorker(confirmAction.limit);
                  }
                  setConfirmAction(null);
                }}
                disabled={bulkRunning}
                className="px-4 py-2 rounded-xl bg-green-700 hover:bg-green-800 text-white font-semibold text-sm disabled:opacity-60"
              >
                {bulkRunning
                  ? language === "th"
                    ? "กำลังทำงาน..."
                    : "Running..."
                  : language === "th"
                  ? "ยืนยัน"
                  : "Confirm"}
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
  tone: "yellow" | "red" | "green" | "gray";
}) {
  const toneClass = {
    yellow: "border-yellow-100 bg-yellow-50 text-yellow-900",
    red: "border-red-100 bg-red-50 text-red-900",
    green: "border-green-100 bg-green-50 text-green-900",
    gray: "border-gray-100 bg-gray-50 text-gray-700",
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

function AutoRetryPanel({
  language,
  lastCronRun,
  lastManualRun,
  deadCount,
}: {
  language: "th" | "en";
  lastCronRun: WorkerRunRow | null;
  lastManualRun: WorkerRunRow | null;
  deadCount: number;
}) {
  const formatAge = (iso: string | null): string => {
    if (!iso) return language === "th" ? "ยังไม่เคย" : "never";
    const ageMs = Date.now() - new Date(iso).getTime();
    if (ageMs < 0) return new Date(iso).toLocaleString("th-TH");
    const mins = Math.floor(ageMs / 60000);
    if (mins < 1) return language === "th" ? "เมื่อสักครู่" : "just now";
    if (mins < 60) return language === "th" ? `${mins} นาทีที่แล้ว` : `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return language === "th" ? `${hours} ชั่วโมงที่แล้ว` : `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return language === "th" ? `${days} วันที่แล้ว` : `${days}d ago`;
  };

  const summarise = (run: WorkerRunRow | null): string => {
    if (!run) return "—";
    return language === "th"
      ? `สำเร็จ ${run.succeeded} • ล้มเหลว ${run.failed} • ตาย ${run.dead} • ข้าม ${run.skipped} (จาก ${run.processed} รายการ)`
      : `ok ${run.succeeded} • fail ${run.failed} • dead ${run.dead} • skip ${run.skipped} (of ${run.processed})`;
  };

  const policyEntries = Object.entries(RETRY_POLICIES) as Array<
    [string, RetryPolicy]
  >;

  return (
    <details className="mb-4 rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-gray-800 flex items-center justify-between gap-3">
        <span>
          {language === "th" ? "ระบบ retry อัตโนมัติ" : "Auto-retry status"}
        </span>
        <span className="text-xs font-normal text-gray-500">
          {lastCronRun
            ? language === "th"
              ? `cron: ${formatAge(lastCronRun.finished_at)}`
              : `cron: ${formatAge(lastCronRun.finished_at)}`
            : language === "th"
            ? "cron: ยังไม่เคยทำงาน"
            : "cron: never run"}
          {deadCount > 0 && (
            <span className="ml-2 inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-800">
              {language === "th" ? `ตาย ${deadCount}` : `dead ${deadCount}`}
            </span>
          )}
        </span>
      </summary>
      <div className="border-t border-gray-100 p-4 space-y-4 text-sm">
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="rounded-xl border border-blue-100 bg-blue-50 p-3">
            <p className="text-[11px] uppercase tracking-widest text-blue-700 font-semibold">
              {language === "th" ? "cron ล่าสุด" : "Last cron tick"}
            </p>
            <p className="mt-1 font-medium text-blue-900">
              {lastCronRun
                ? `${formatAge(lastCronRun.finished_at)} (${new Date(
                    lastCronRun.finished_at
                  ).toLocaleString("th-TH", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })})`
                : language === "th"
                ? "ยังไม่เคยทำงาน — ตั้ง CRON_SECRET + Vercel/Supabase Cron"
                : "Never run — set CRON_SECRET + Vercel/Supabase Cron"}
            </p>
            <p className="text-[11px] text-blue-700 mt-1">
              {summarise(lastCronRun)}
            </p>
          </div>
          <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
            <p className="text-[11px] uppercase tracking-widest text-gray-600 font-semibold">
              {language === "th" ? "manual ล่าสุด" : "Last manual run"}
            </p>
            <p className="mt-1 font-medium text-gray-800">
              {lastManualRun
                ? `${formatAge(lastManualRun.finished_at)} (${
                    lastManualRun.actor_id ?? "?"
                  })`
                : language === "th"
                ? "ยังไม่เคยกด Run worker"
                : "No manual run yet"}
            </p>
            <p className="text-[11px] text-gray-600 mt-1">
              {summarise(lastManualRun)}
            </p>
          </div>
        </div>

        <div>
          <p className="text-[11px] uppercase tracking-widest text-gray-500 font-semibold mb-2">
            {language === "th" ? "นโยบาย retry ต่อชนิด" : "Per-kind retry policy"}
          </p>
          <div className="overflow-x-auto rounded-xl border border-gray-100">
            <table className="w-full text-[12px]">
              <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="text-left p-2">{language === "th" ? "ชนิด" : "Kind"}</th>
                  <th className="text-left p-2">
                    {language === "th" ? "Auto" : "Auto"}
                  </th>
                  <th className="text-left p-2">
                    {language === "th" ? "ลองสูงสุด" : "Max attempts"}
                  </th>
                  <th className="text-left p-2">
                    {language === "th" ? "Cooldown" : "Cooldown"}
                  </th>
                  <th className="text-left p-2">
                    {language === "th" ? "เหตุผล" : "Reason"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {policyEntries.map(([kind, policy]) => (
                  <tr key={kind} className="border-t border-gray-100 align-top">
                    <td className="p-2 font-mono text-gray-800">{kind}</td>
                    <td className="p-2">
                      {policy.autoRetry ? (
                        <span className="inline-flex rounded-full border border-green-200 bg-green-50 text-green-800 px-2 py-0.5 text-[10px] font-semibold">
                          auto
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full border border-gray-200 bg-gray-50 text-gray-600 px-2 py-0.5 text-[10px] font-semibold">
                          manual
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-gray-800">
                      {policy.autoRetry ? policy.maxAttempts : "—"}
                    </td>
                    <td className="p-2 text-gray-800">
                      {policy.autoRetry ? `${policy.cooldownSeconds}s` : "—"}
                    </td>
                    <td className="p-2 text-gray-600">
                      {language === "th"
                        ? policy.description.th
                        : policy.description.en}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </details>
  );
}

function BulkActionBar({
  language,
  canRetry,
  selectedCount,
  pendingCount,
  bulkRunning,
  onBulkResolve,
  onRunWorker,
  onClearSelection,
}: {
  language: "th" | "en";
  canRetry: boolean;
  selectedCount: number;
  pendingCount: number;
  bulkRunning: boolean;
  onBulkResolve: () => void;
  onRunWorker: () => void;
  onClearSelection: () => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-sm text-gray-700">
        {language === "th"
          ? selectedCount > 0
            ? `เลือกไว้ ${selectedCount} รายการ`
            : `รอจัดการ ${pendingCount} รายการ`
          : selectedCount > 0
          ? `${selectedCount} selected`
          : `${pendingCount} pending`}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {selectedCount > 0 && (
          <button
            type="button"
            onClick={onClearSelection}
            className="text-xs text-gray-600 hover:text-gray-900"
          >
            {language === "th" ? "ล้างที่เลือก" : "Clear"}
          </button>
        )}
        <button
          type="button"
          onClick={onBulkResolve}
          disabled={!canRetry || selectedCount === 0 || bulkRunning}
          className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 min-h-[40px]"
        >
          {language === "th"
            ? `ทำเสร็จที่เลือก (${selectedCount})`
            : `Resolve selected (${selectedCount})`}
        </button>
        <button
          type="button"
          onClick={onRunWorker}
          disabled={!canRetry || pendingCount === 0 || bulkRunning}
          className="rounded-xl bg-green-700 hover:bg-green-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50 min-h-[40px]"
        >
          {bulkRunning
            ? language === "th"
              ? "กำลังทำงาน..."
              : "Working..."
            : language === "th"
            ? "รัน worker (25 รายการ)"
            : "Run worker (25)"}
        </button>
      </div>
    </div>
  );
}

function WorkerSummary({
  language,
  result,
  onDismiss,
}: {
  language: "th" | "en";
  result: RetryTickResult;
  onDismiss: () => void;
}) {
  return (
    <div className="mb-3 rounded-2xl border border-green-200 bg-green-50 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-green-900">
            {language === "th" ? "ผลการรัน worker" : "Worker tick result"}
          </p>
          <p className="text-xs text-green-800 mt-0.5">
            {language === "th"
              ? `เริ่ม ${new Date(result.startedAt).toLocaleTimeString("th-TH")} • ${result.processed} รายการ • ${result.scopedBranch ? `สาขา ${result.scopedBranch}` : "ทุกสาขา"}`
              : `Started ${new Date(result.startedAt).toLocaleTimeString()} • ${result.processed} processed • ${result.scopedBranch ? `branch ${result.scopedBranch}` : "all branches"}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-green-700 hover:text-green-900 text-lg leading-none"
          aria-label="dismiss"
        >
          ✕
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
        <span className="rounded-lg border border-green-200 bg-white px-2 py-1">
          {language === "th" ? "สำเร็จ" : "Succeeded"}: <strong>{result.succeeded}</strong>
        </span>
        <span className="rounded-lg border border-yellow-200 bg-white px-2 py-1">
          {language === "th" ? "ยังคิวอยู่" : "Pending"}: <strong>{result.failed}</strong>
        </span>
        <span className="rounded-lg border border-red-200 bg-white px-2 py-1">
          {language === "th" ? "ตาย" : "Dead"}: <strong>{result.dead}</strong>
        </span>
        <span className="rounded-lg border border-gray-200 bg-white px-2 py-1">
          {language === "th" ? "ข้าม (cooldown)" : "Skipped"}: <strong>{result.skipped}</strong>
        </span>
      </div>
      {result.items.some((i) => i.reason) && (
        <details className="mt-2">
          <summary className="text-[11px] text-green-700 cursor-pointer">
            {language === "th" ? "ดูรายละเอียดต่อรายการ" : "Per-row details"}
          </summary>
          <ul className="mt-1 space-y-0.5 text-[11px] text-gray-700">
            {result.items.map((i, idx) => (
              <li key={`${i.failureId}-${idx}`} className="font-mono">
                {i.succeeded ? "✓" : i.dead ? "💀" : i.skipped ? "·" : "↻"}{" "}
                {i.kind} · {i.targetId ?? "—"}
                {i.reason ? ` · ${i.reason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function SyncFailuresTable({
  rows,
  isLoading,
  canRetry,
  retrying,
  resolving,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onRetry,
  onResolve,
  onInspect,
  language,
}: {
  rows: SyncFailureRow[];
  isLoading: boolean;
  canRetry: boolean;
  retrying: Set<string>;
  resolving: Set<string>;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onRetry: (row: SyncFailureRow) => void;
  onResolve: (failureId: string) => void;
  onInspect: (row: SyncFailureRow) => void;
  language: "th" | "en";
}) {
  const eligibleVisible = rows.filter((r) => r.status !== "resolved");
  const allEligibleSelected =
    eligibleVisible.length > 0 &&
    eligibleVisible.every((r) => selectedIds.has(r.id));
  return (
    <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
      {isLoading ? (
        <div className="p-8 text-center text-gray-500">
          {language === "th" ? "กำลังโหลด..." : "Loading..."}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-gray-500">
          {language === "th"
            ? "ไม่มีรายการตามตัวกรอง — ระบบยังไม่บันทึก sync failure ในช่วงนี้"
            : "No rows match the active filters."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="p-3 w-8 text-left">
                  <input
                    type="checkbox"
                    checked={allEligibleSelected}
                    onChange={onToggleSelectAll}
                    disabled={!canRetry || eligibleVisible.length === 0}
                    aria-label={
                      language === "th"
                        ? "เลือกทั้งหมดที่มองเห็น"
                        : "Select all visible"
                    }
                    className="w-4 h-4 accent-green-700"
                  />
                </th>
                <th className="text-left p-3">{language === "th" ? "ชนิด" : "Kind"}</th>
                <th className="text-left p-3">{language === "th" ? "เป้าหมาย" : "Target"}</th>
                <th className="text-left p-3">{language === "th" ? "สาขา" : "Branch"}</th>
                <th className="text-left p-3">{language === "th" ? "สถานะ" : "Status"}</th>
                <th className="text-left p-3">{language === "th" ? "เหตุผล" : "Reason"}</th>
                <th className="text-left p-3">{language === "th" ? "บันทึก" : "Created"}</th>
                <th className="text-right p-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const kindLabel =
                  SYNC_KIND_LABELS[row.kind]?.[language === "th" ? "th" : "en"] ?? row.kind;
                const isRetrying = retrying.has(row.id);
                const isResolving = resolving.has(row.id);
                const disabled = !canRetry || row.status === "resolved";
                const isSelected = selectedIds.has(row.id);
                return (
                  <tr
                    key={row.id}
                    className={`border-t border-gray-100 align-top ${
                      isSelected ? "bg-green-50/60" : "hover:bg-green-50/30"
                    }`}
                  >
                    <td className="p-3 w-8">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleSelect(row.id)}
                        disabled={!canRetry || row.status === "resolved"}
                        aria-label="select row"
                        className="w-4 h-4 accent-green-700"
                      />
                    </td>
                    <td className="p-3 text-gray-800 font-medium">{kindLabel}</td>
                    <td className="p-3 text-gray-700 font-mono text-[11px] break-all">
                      {row.target_id ?? "—"}
                    </td>
                    <td className="p-3 text-gray-700">{row.branch_id ?? "—"}</td>
                    <td className="p-3">
                      <span
                        className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          SYNC_STATUS_TONE[row.status]
                        }`}
                      >
                        {row.status}
                      </span>
                      <p className="mt-1 text-[10px] text-gray-500">
                        {language === "th" ? "ลอง" : "Attempts"}: {row.attempts}
                      </p>
                    </td>
                    <td className="p-3 text-[12px] text-gray-700 max-w-xs">
                      <p className="line-clamp-3">{row.reason}</p>
                    </td>
                    <td className="p-3 text-[12px] text-gray-600 whitespace-nowrap">
                      {fmtDate(row.created_at)}
                      {row.last_attempt_at ? (
                        <span className="block text-[10px] text-gray-400">
                          {language === "th" ? "ล่าสุด" : "Last"}:{" "}
                          {fmtDate(row.last_attempt_at)}
                        </span>
                      ) : null}
                    </td>
                    <td className="p-3 text-right whitespace-nowrap space-x-1">
                      <button
                        type="button"
                        onClick={() => onInspect(row)}
                        className="px-2 py-1 rounded-md border border-gray-200 bg-white text-[11px] font-medium text-gray-700 hover:bg-gray-50"
                      >
                        {language === "th" ? "ดูข้อมูล" : "Inspect"}
                      </button>
                      <button
                        type="button"
                        onClick={() => onRetry(row)}
                        disabled={disabled || isRetrying}
                        className="px-2 py-1 rounded-md border border-green-300 bg-white text-[11px] font-semibold text-green-700 hover:bg-green-50 disabled:opacity-50"
                      >
                        {isRetrying
                          ? language === "th"
                            ? "กำลังลอง..."
                            : "Retrying..."
                          : language === "th"
                          ? "ลองใหม่"
                          : "Retry"}
                      </button>
                      <button
                        type="button"
                        onClick={() => onResolve(row.id)}
                        disabled={disabled || isResolving}
                        className="px-2 py-1 rounded-md border border-gray-300 bg-white text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {isResolving
                          ? language === "th"
                            ? "บันทึก..."
                            : "Saving..."
                          : language === "th"
                          ? "ทำเสร็จ"
                          : "Resolved"}
                      </button>
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

function LineLogTable({
  rows,
  isLoading,
  canRetry,
  retrying,
  onResend,
  onInspect,
  language,
}: {
  rows: LineMessageLogRow[];
  isLoading: boolean;
  canRetry: boolean;
  retrying: Set<string>;
  onResend: (row: LineMessageLogRow) => void;
  onInspect: (row: LineMessageLogRow) => void;
  language: "th" | "en";
}) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
      {isLoading ? (
        <div className="p-8 text-center text-gray-500">
          {language === "th" ? "กำลังโหลด..." : "Loading..."}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-gray-500">
          {language === "th"
            ? "ไม่มี LINE log ในช่วงนี้ — ระบบ LINE OA อาจยังไม่ได้ตั้งค่า หรือยังไม่มีการส่งจริง"
            : "No LINE log rows. LINE OA may not be configured, or no sends happened yet."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="text-left p-3">{language === "th" ? "ชนิด" : "Kind"}</th>
                <th className="text-left p-3">{language === "th" ? "ใบงาน" : "Order"}</th>
                <th className="text-left p-3">{language === "th" ? "สาขา" : "Branch"}</th>
                <th className="text-left p-3">{language === "th" ? "สถานะ" : "Status"}</th>
                <th className="text-left p-3">{language === "th" ? "เหตุผล" : "Reason"}</th>
                <th className="text-left p-3">{language === "th" ? "เวลา" : "Created"}</th>
                <th className="text-right p-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isRetrying = retrying.has(row.id);
                const canResend =
                  canRetry &&
                  !!row.order_id &&
                  (row.status === "failed" || row.status === "skipped");
                return (
                  <tr
                    key={row.id}
                    className="border-t border-gray-100 hover:bg-green-50/30 align-top"
                  >
                    <td className="p-3 text-gray-800 font-medium">
                      {LINE_KIND_LABELS[row.kind]?.[language === "th" ? "th" : "en"] ?? row.kind}
                    </td>
                    <td className="p-3 text-gray-700 font-mono text-[11px] break-all">
                      {row.order_id ?? "—"}
                    </td>
                    <td className="p-3 text-gray-700">{row.branch_id ?? "—"}</td>
                    <td className="p-3">
                      <span
                        className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          LINE_STATUS_TONE[row.status]
                        }`}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="p-3 text-[12px] text-gray-700 max-w-xs">
                      <p className="line-clamp-3">{row.error_reason ?? "—"}</p>
                    </td>
                    <td className="p-3 text-[12px] text-gray-600 whitespace-nowrap">
                      {fmtDate(row.created_at)}
                      {row.sent_at ? (
                        <span className="block text-[10px] text-gray-400">
                          {language === "th" ? "ส่ง" : "Sent"}: {fmtDate(row.sent_at)}
                        </span>
                      ) : null}
                    </td>
                    <td className="p-3 text-right whitespace-nowrap space-x-1">
                      <button
                        type="button"
                        onClick={() => onInspect(row)}
                        className="px-2 py-1 rounded-md border border-gray-200 bg-white text-[11px] font-medium text-gray-700 hover:bg-gray-50"
                      >
                        {language === "th" ? "ดูข้อมูล" : "Inspect"}
                      </button>
                      <button
                        type="button"
                        onClick={() => onResend(row)}
                        disabled={!canResend || isRetrying}
                        className="px-2 py-1 rounded-md border border-green-300 bg-white text-[11px] font-semibold text-green-700 hover:bg-green-50 disabled:opacity-50"
                      >
                        {isRetrying
                          ? language === "th"
                            ? "กำลังส่ง..."
                            : "Sending..."
                          : language === "th"
                          ? "ส่งซ้ำ"
                          : "Resend"}
                      </button>
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

function ReceiptRebuildPanel({
  orderId,
  onChange,
  onRebuild,
  loading,
  error,
  receipt,
  language,
}: {
  orderId: string;
  onChange: (next: string) => void;
  onRebuild: () => void;
  loading: boolean;
  error: string | null;
  receipt: ReceiptData | null;
  language: "th" | "en";
}) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white shadow-sm p-5 space-y-4">
      <div>
        <h2 className="text-lg font-bold text-gray-900">
          {language === "th" ? "สร้างใบเสร็จใหม่จาก order id" : "Rebuild receipt by order id"}
        </h2>
        <p className="text-xs text-gray-500 mt-1">
          {language === "th"
            ? "ใช้เมื่อใบเสร็จที่แสดงไม่อัปเดต หรือข้อมูลในใบเสร็จไม่ตรงกับ DB — ระบบจะอ่านใบงานใหม่และสร้าง ReceiptData ตามที่ควรเป็น"
            : "Use when the printed receipt looks stale or the cached UI state drifted — re-derives ReceiptData from the live order/customer rows."}
        </p>
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={orderId}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            language === "th"
              ? "วาง order uuid (เช่น 11111111-aaaa-...)"
              : "Paste order uuid"
          }
          className="flex-1 rounded-xl border border-gray-200 px-3 py-3 text-sm font-mono outline-none focus:ring-2 focus:ring-green-500"
        />
        <button
          type="button"
          onClick={onRebuild}
          disabled={loading || !orderId.trim()}
          className="rounded-xl bg-green-700 hover:bg-green-800 text-white font-semibold px-5 py-3 text-sm disabled:opacity-50 min-h-[44px]"
        >
          {loading
            ? language === "th"
              ? "กำลังสร้าง..."
              : "Rebuilding..."
            : language === "th"
            ? "สร้างใหม่"
            : "Rebuild"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {receipt && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-green-800">
            {language === "th"
              ? `สร้างใหม่สำเร็จ — Ref ${receipt.meta.refId} • ลูกค้า ${receipt.customer.name}`
              : `Rebuilt — ref ${receipt.meta.refId} • customer ${receipt.customer.name}`}
          </p>
          <pre className="text-[11px] bg-gray-50 border border-gray-200 rounded-lg p-3 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words">
            {JSON.stringify(receipt, null, 2)}
          </pre>
          <p className="text-[11px] text-gray-500">
            {language === "th"
              ? "ผลลัพธ์นี้ดึงจากข้อมูลล่าสุดใน DB — เมื่อเปิดหน้าใบเสร็จของใบงานนี้ใหม่ ระบบจะใช้ข้อมูลเดียวกัน"
              : "Result reads from the live DB. Opening the order's document page now will show identical values."}
          </p>
        </div>
      )}
    </div>
  );
}
