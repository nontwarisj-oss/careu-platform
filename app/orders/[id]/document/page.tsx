"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import supabase from "@/lib/supabase";
import { useBranch } from "@/lib/branchContext";
import { getBranchById } from "@/lib/brandConfig";
import {
  buildCustomerMessage,
  type DocumentOrder,
} from "@/lib/customerMessage";
import { sendToLineOA } from "@/lib/lineOA";
import { triggerLifecycleEvent } from "@/lib/lifecycleClient";
import { useAuth } from "@/lib/authContext";
import { buildReceiptData, type ReceiptData } from "@/lib/receiptData";
import { fetchOrderItems, type OrderItemRow } from "@/lib/orderItems";
import { OrderPhotoGallery } from "@/components/OrderPhotoGallery";
import {
  printReceipt,
  saveReceiptAsImage,
  type PrintMode,
} from "@/lib/printService";
import { ReceiptA4 } from "@/components/receipt/ReceiptA4";
import { ReceiptThermal } from "@/components/receipt/ReceiptThermal";
import { ReceiptMobile } from "@/components/receipt/ReceiptMobile";
import { PrintModeSelector } from "@/components/receipt/PrintModeSelector";

type RouteParams = { id: string };

const PAYMENT_OPTIONS = [
  { value: "unpaid", label: "ยังไม่ชำระ" },
  { value: "deposit", label: "มัดจำ" },
  { value: "paid", label: "ชำระแล้ว" },
];

export default function OrderDocumentPage({
  params,
}: {
  params: Promise<RouteParams>;
}) {
  const { id: orderId } = use(params);
  const { branch: currentBranch } = useBranch();
  const { user } = useAuth();

  const writeAudit = async (
    action: "status_changed" | "payment_changed" | "sync_pushed",
    before: string | null,
    after: string | null
  ) => {
    const res = await supabase.from("order_audit_log").insert({
      order_id: orderId,
      action,
      before_value: before,
      after_value: after,
      changed_by: user?.uid ?? null,
    });
    if (
      res.error &&
      !/column .* does not exist|schema cache|relation .* does not exist/i.test(
        res.error.message
      )
    ) {
      console.warn("[order-document] audit write failed", res.error.message);
    }
  };

  const [order, setOrder] = useState<DocumentOrder | null>(null);
  const [orderItems, setOrderItems] = useState<OrderItemRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [orderBranchId, setOrderBranchId] = useState<string | null>(null);
  const [orderJobId, setOrderJobId] = useState<string | null>(null);
  const [orderDueDate, setOrderDueDate] = useState<string | null>(null);
  const [orderTech, setOrderTech] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [sheetSyncStatus, setSheetSyncStatus] = useState<
    "idle" | "syncing" | "success" | "failed"
  >("idle");
  const [sheetSyncError, setSheetSyncError] = useState<string | null>(null);
  const [printMode, setPrintMode] = useState<PrintMode>("a4");

  useEffect(() => {
    void (async () => {
      setIsLoading(true);
      setErrorMessage(null);

      // Try the widest column set, then narrow on column-missing errors so the
      // page renders on any migration state.
      const wide =
        "id, customer_id, customer_name, item_name, price, status, created_at, notes, urgent, urgent_fee, branch_id, subtotal, discount, quantity, service_category, service_code, service_name, template_text, customer_type, promotion_code, payment_status, payment_method, job_id, due_date, tech";
      let raw: Record<string, unknown> | null = null;

      const tryFetch = async (cols: string) =>
        await supabase
          .from("orders")
          .select(cols)
          .eq("id", orderId)
          .maybeSingle();

      // Every tier that can carry job_id keeps it (only the legacy
      // floor predates the column). The dedicated job_id fetch below
      // is the real source of truth — these just avoid losing it.
      const tries = [
        wide,
        // drop assignment fields (due_date, tech); keep job_id
        "id, customer_id, customer_name, item_name, price, status, created_at, notes, urgent, urgent_fee, branch_id, subtotal, discount, quantity, service_category, service_code, service_name, template_text, customer_type, promotion_code, payment_status, payment_method, job_id",
        // drop payment_* and document_type; keep job_id
        "id, customer_id, customer_name, item_name, price, status, created_at, notes, urgent, urgent_fee, branch_id, subtotal, discount, quantity, service_category, service_code, service_name, template_text, customer_type, promotion_code, job_id",
        // drop smart cols; keep job_id
        "id, customer_id, customer_name, item_name, price, status, created_at, notes, urgent, urgent_fee, branch_id, job_id",
        // legacy floor — pre-20260520 schema, no job_id column
        "id, customer_id, customer_name, item_name, price, status, created_at",
      ];
      for (const cols of tries) {
        const res = await tryFetch(cols);
        if (!res.error && res.data) {
          raw = res.data as unknown as Record<string, unknown>;
          break;
        }
      }

      if (!raw) {
        setErrorMessage("ไม่พบใบงาน หรือใบงานถูกลบไปแล้ว");
        setIsLoading(false);
        return;
      }

      const customerId = (raw.customer_id as string | null) ?? null;
      let phone: string | null = null;
      if (customerId) {
        const cust = await supabase
          .from("customers")
          .select("phone")
          .eq("id", customerId)
          .maybeSingle();
        if (cust.data && (cust.data as { phone?: string }).phone) {
          phone = (cust.data as { phone: string }).phone;
        }
      }

      setOrderBranchId((raw.branch_id as string | null) ?? null);

      // Job ID — fetched INDEPENDENTLY of the tiered select above. That
      // select can fail on an unrelated missing column and fall back to
      // a narrower tier that omits job_id, losing a Job ID that is
      // actually saved. This dedicated minimal select("job_id") is the
      // source of truth; only a genuine null here shows "ยังไม่มีรหัสงาน".
      const jobIdRes = await supabase
        .from("orders")
        .select("job_id")
        .eq("id", orderId)
        .maybeSingle();
      const directJobId =
        (jobIdRes.data as unknown as { job_id: string | null } | null)
          ?.job_id ?? null;
      // The direct query is authoritative. raw.job_id (kept by the
      // tiered select when its tier carries the column) is only a
      // secondary fallback — used solely if the direct query is null.
      const resolvedJobId =
        directJobId ?? (raw.job_id as string | null) ?? null;
      setOrderJobId(resolvedJobId);

      setOrderDueDate((raw.due_date as string | null) ?? null);
      setOrderTech((raw.tech as string | null) ?? null);

      setOrder({
        id: String(raw.id),
        customer_name: (raw.customer_name as string) ?? "",
        customer_phone: phone,
        item_name: (raw.item_name as string) ?? "",
        price: Number(raw.price ?? 0),
        subtotal:
          raw.subtotal !== null && raw.subtotal !== undefined
            ? Number(raw.subtotal)
            : null,
        discount: Number(raw.discount ?? 0),
        urgent: Boolean(raw.urgent),
        urgent_fee: Number(raw.urgent_fee ?? 0),
        quantity: Number(raw.quantity ?? 1),
        status: (raw.status as string) ?? "pending",
        notes: (raw.notes as string) ?? null,
        service_category: (raw.service_category as string) ?? null,
        service_code: (raw.service_code as string) ?? null,
        service_name: (raw.service_name as string) ?? null,
        template_text: (raw.template_text as string) ?? null,
        customer_type: (raw.customer_type as string) ?? null,
        promotion_code: (raw.promotion_code as string) ?? null,
        payment_status: (raw.payment_status as string) ?? "unpaid",
        created_at: (raw.created_at as string) ?? new Date().toISOString(),
      });

      // Multi-item rows (Phase A). Empty for legacy single-item orders —
      // the receipt then falls back to the header's own columns.
      setOrderItems(await fetchOrderItems(supabase, orderId));

      setIsLoading(false);
    })();
  }, [orderId]);

  const branch = orderBranchId ? getBranchById(orderBranchId) : currentBranch;

  // Build the receipt data object once per render. Pure transformation —
  // every template component consumes this.
  const receipt: ReceiptData | null = useMemo(() => {
    if (!order) return null;
    return buildReceiptData({
      order,
      branchId: orderBranchId,
      customerPhone: order.customer_phone ?? null,
      jobId: orderJobId,
      dueDate: orderDueDate,
      technicianLabel: orderTech,
      orderItems,
    });
  }, [order, orderBranchId, orderJobId, orderDueDate, orderTech, orderItems]);

  // ---- Action handlers ---------------------------------------------------

  const handlePrint = () => {
    if (!receipt) return;
    printReceipt({ mode: printMode });
  };

  const handleSaveImage = async () => {
    if (!receipt) return;
    setToast("กำลังสร้างรูปภาพ...");
    const res = await saveReceiptAsImage({ receipt });
    setToast(
      res.ok ? "บันทึกเป็นรูปภาพเรียบร้อย" : `บันทึกรูปไม่สำเร็จ: ${res.reason}`
    );
    setTimeout(() => setToast(null), 4000);
  };

  const handleCopyMessage = async () => {
    if (!order) return;
    const text = buildCustomerMessage(order, branch, orderJobId);
    try {
      await navigator.clipboard.writeText(text);
      setToast("คัดลอกข้อความเรียบร้อย พร้อมส่งให้ลูกค้า");
    } catch {
      setToast("ไม่สามารถคัดลอกได้ — โปรดลองอีกครั้ง");
    }
    setTimeout(() => setToast(null), 3500);
  };

  const handleSendLine = async () => {
    if (!order) return;
    const text = buildCustomerMessage(order, branch, orderJobId);
    const res = await sendToLineOA(order.id, text);
    setToast(res.ok ? "ส่งเข้า LINE OA สำเร็จ" : res.reason ?? "ส่งไม่สำเร็จ");
    setTimeout(() => setToast(null), 4500);
  };

  const handleSyncToSheet = async () => {
    if (!order) return;
    setSheetSyncStatus("syncing");
    setSheetSyncError(null);
    try {
      const res = await fetch("/api/sync-order-to-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id }),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !json.ok) {
        setSheetSyncStatus("failed");
        setSheetSyncError(json.reason ?? `HTTP ${res.status}`);
        setToast(`ซิงค์ไป Google Sheet ไม่สำเร็จ: ${json.reason ?? res.status}`);
      } else {
        setSheetSyncStatus("success");
        setToast("ซิงค์ไป Google Sheet เรียบร้อย");
        void writeAudit("sync_pushed", null, "front_desk_tab");
      }
    } catch (err) {
      setSheetSyncStatus("failed");
      setSheetSyncError(err instanceof Error ? err.message : "Network error");
      setToast("ซิงค์ไป Google Sheet ไม่สำเร็จ — เครือข่ายขัดข้อง");
    }
    setTimeout(() => setToast(null), 4000);
  };

  const handlePaymentChange = async (next: string) => {
    if (!order) return;
    setPaymentSaving(true);
    const previous = order.payment_status;
    setOrder({ ...order, payment_status: next });
    try {
      const res = await fetch(`/api/orders/${order.id}/payment-status`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentStatus: next }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        paymentStatus?: string;
      };
      if (!res.ok || !json.ok) {
        console.error(
          "[order-document] payment status update failed",
          json.reason ?? `HTTP ${res.status}`
        );
        setOrder({ ...order, payment_status: previous });
        setToast(json.reason ?? `HTTP ${res.status}`);
        setTimeout(() => setToast(null), 5000);
        return;
      }
      setToast("บันทึกสถานะการชำระเรียบร้อย");
      const savedStatus = json.paymentStatus ?? next;
      setOrder({ ...order, payment_status: savedStatus });
      if (next === "paid") {
        void triggerLifecycleEvent("payment_received", order.id);
      }
      setTimeout(() => window.location.reload(), 300);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      console.error("[order-document] payment status update failed", err);
      setOrder({ ...order, payment_status: previous });
      setToast(message);
      setTimeout(() => setToast(null), 5000);
    } finally {
      setPaymentSaving(false);
    }
  };

  // ---- Render ------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="p-8 text-center text-gray-500">กำลังโหลดเอกสาร...</div>
    );
  }
  if (errorMessage || !order || !receipt) {
    return (
      <div className="p-8">
        <div className="max-w-md mx-auto rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage ?? "ไม่พบใบงาน"}
        </div>
      </div>
    );
  }

  const ReceiptForMode =
    printMode === "thermal"
      ? ReceiptThermal
      : printMode === "mobile"
      ? ReceiptMobile
      : ReceiptA4;

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="max-w-3xl mx-auto">
        {/* Action bar — hidden from print */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4 print:hidden">
          <Link
            href="/orders"
            className="text-sm text-green-700 hover:text-green-800 font-medium"
          >
            ← กลับไปคำสั่งซ่อม
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <PrintModeSelector value={printMode} onChange={setPrintMode} />
            <button
              onClick={handlePrint}
              className="px-3 py-2 rounded-lg bg-green-700 hover:bg-green-800 text-white text-sm font-medium"
            >
              พิมพ์เอกสาร
            </button>
            <button
              onClick={handleSaveImage}
              className="px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium"
            >
              บันทึกเป็นรูปภาพ
            </button>
            <button
              onClick={() => void handleSendLine()}
              className="px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium"
            >
              ส่ง Line OA
            </button>
            <button
              onClick={() => void handleCopyMessage()}
              className="px-3 py-2 rounded-lg border border-green-600 text-green-700 hover:bg-green-50 text-sm font-medium"
            >
              คัดลอกข้อความส่งลูกค้า
            </button>
            <button
              onClick={() => void handleSyncToSheet()}
              disabled={sheetSyncStatus === "syncing"}
              className="px-3 py-2 rounded-lg border border-green-600 text-green-700 hover:bg-green-50 text-sm font-medium disabled:opacity-50"
            >
              {sheetSyncStatus === "syncing"
                ? "กำลังซิงค์..."
                : sheetSyncStatus === "failed"
                ? "ลองซิงค์ Google Sheet อีกครั้ง"
                : "ซิงค์ไป Google Sheet"}
            </button>
            <ManualSendMenu orderId={order.id} onResult={(msg) => {
              setToast(msg);
              setTimeout(() => setToast(null), 4000);
            }} />
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-medium border ${
                sheetSyncStatus === "success"
                  ? "bg-green-50 text-green-800 border-green-200"
                  : sheetSyncStatus === "failed"
                  ? "bg-red-50 text-red-700 border-red-200"
                  : sheetSyncStatus === "syncing"
                  ? "bg-yellow-50 text-yellow-800 border-yellow-200"
                  : "bg-gray-50 text-gray-600 border-gray-200"
              }`}
              title={sheetSyncError ?? undefined}
            >
              {sheetSyncStatus === "success"
                ? "Sheet • ซิงค์แล้ว"
                : sheetSyncStatus === "failed"
                ? "Sheet • ล้มเหลว"
                : sheetSyncStatus === "syncing"
                ? "Sheet • กำลังซิงค์"
                : "Sheet • รอซิงค์"}
            </span>
          </div>
        </div>

        {toast && (
          <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800 print:hidden">
            {toast}
          </div>
        )}

        {/* Receipt — one of three templates based on print mode */}
        <ReceiptForMode receipt={receipt} />

        {/* Internal staff controls — never printed */}
        <div className="mt-4 space-y-4 print:hidden">
          {/* Order-wide repair photo gallery */}
          <OrderPhotoGallery items={orderItems} />

          {/* Payment status selector (data persisted on the order) */}
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-2">
              เปลี่ยนสถานะการชำระ
            </p>
            <div className="flex items-center gap-2">
              <select
                value={order.payment_status ?? "unpaid"}
                onChange={(e) => void handlePaymentChange(e.target.value)}
                disabled={paymentSaving}
                className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm"
              >
                {PAYMENT_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-gray-500">
                บันทึกอัตโนมัติเมื่อเลือก
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type ManualSendEvent =
  | "ready_for_pickup"
  | "overdue_pickup"
  | "payment_received"
  | "order_completed";

const MANUAL_SEND_OPTIONS: Array<{ value: ManualSendEvent; label: string }> = [
  { value: "ready_for_pickup", label: "แจ้งพร้อมรับ" },
  { value: "overdue_pickup", label: "เตือนยังไม่รับ" },
  { value: "payment_received", label: "แจ้งรับชำระ" },
  { value: "order_completed", label: "แจ้งงานเสร็จ" },
];

function ManualSendMenu({
  orderId,
  onResult,
}: {
  orderId: string;
  onResult: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ManualSendEvent | null>(null);

  const handle = async (event: ManualSendEvent, label: string) => {
    if (busy) return;
    setBusy(event);
    setOpen(false);
    try {
      const res = await fetch("/api/admin/notifications/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, orderId }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        skippedReason?: string | null;
        outcomes?: Array<{ enqueued: boolean; reason: string | null; channel: string }>;
      };
      if (!res.ok || !json.ok) {
        onResult(`ส่งไม่สำเร็จ: ${json.reason ?? `HTTP ${res.status}`}`);
        return;
      }
      const enqueued = (json.outcomes ?? []).filter((o) => o.enqueued).length;
      const skipped = (json.outcomes ?? []).filter((o) => !o.enqueued);
      if (enqueued > 0) {
        onResult(`${label} — ส่งเข้าคิวแล้ว (${enqueued} ช่องทาง)`);
      } else {
        const skipReasons = skipped
          .map((s) => `${s.channel}: ${s.reason ?? "—"}`)
          .join(" / ");
        onResult(
          `${label} — ไม่มีช่องทางส่ง${
            json.skippedReason ? ` (${json.skippedReason})` : ` (${skipReasons})`
          }`
        );
      }
    } catch (err) {
      onResult(
        `ส่งไม่สำเร็จ: ${err instanceof Error ? err.message : "Network error"}`
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-2 rounded-lg border border-purple-600 text-purple-700 hover:bg-purple-50 text-sm font-medium"
      >
        แจ้งลูกค้าด้วยตนเอง ▾
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-56 rounded-xl border border-gray-200 bg-white shadow-lg z-10 overflow-hidden">
          {MANUAL_SEND_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => void handle(opt.value, opt.label)}
              disabled={busy !== null}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-purple-50 disabled:opacity-50"
            >
              {busy === opt.value ? "กำลังส่ง..." : opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
