"use client";

// Orders Operations Board — Store Ops Hardening Phase B.
//
// /orders is the front-counter operations board, NOT a form page. Job
// creation lives at /intake. This screen is for running the floor:
// queue views, status changes, and a fast look at every live ticket.
//
// Framework-consistent: reuses the existing status vocabulary
// (lib/statusBadges) extended additively with the shop-floor states,
// the existing OrderDetailModal, and order_items for the item count.
// No new abstractions — one page, mobile-first cards.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { OrderDetailModal } from "@/components/OrderDetailModal";
import { OrderStatusBadge, PaymentStatusBadge } from "@/components/StatusBadge";
import { ORDER_OPS_FLOW, orderStatusLabel, isOverdue } from "@/lib/statusBadges";
import { getBranchById } from "@/lib/brandConfig";
import { fetchOrderItemsForOrders } from "@/lib/orderItems";
import { useAuth } from "@/lib/authContext";
import { triggerLifecycleEvent } from "@/lib/lifecycleClient";
import type { LifecycleEvent } from "@/lib/lifecycleNotifier";

function mapStatusToLifecycleEvent(
  before: string | null,
  after: string
): LifecycleEvent | null {
  if (after === "in-progress" && before !== "in-progress") return "repair_started";
  if (after === "ready-for-pickup" && before !== "ready-for-pickup")
    return "ready_for_pickup";
  if (after === "completed" && before !== "completed") return "order_completed";
  return null;
}

type BoardOrder = {
  id: string;
  customer_id: string | null;
  customer_name: string;
  item_name: string;
  job_id: string | null;
  status: string;
  payment_status: string;
  price: number;
  urgent: boolean;
  due_date: string | null;
  branch_id: string | null;
  business_type: string | null;
  created_at: string;
  // Derived / joined.
  phone: string | null;
  itemCount: number;
  technicianIds: string[];
};

type Queue =
  | "all"
  | "today"
  | "overdue"
  | "urgent"
  | "ready"
  | "waiting_payment";

const QUEUES: Array<{ key: Queue; label: string }> = [
  { key: "all", label: "ทั้งหมด" },
  { key: "today", label: "กำหนดวันนี้" },
  { key: "overdue", label: "เลยกำหนด" },
  { key: "urgent", label: "งานด่วน" },
  { key: "ready", label: "พร้อมรับ" },
  { key: "waiting_payment", label: "ค้างชำระ" },
];

/** Bangkok-local today as YYYY-MM-DD — matches the date-only due_date. */
function bangkokToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
  }).format(new Date());
}

export default function OrdersBoardPage() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<BoardOrder[]>([]);
  const [techNames, setTechNames] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [queue, setQueue] = useState<Queue>("all");
  const [technicianFilter, setTechnicianFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [detailOrder, setDetailOrder] = useState<BoardOrder | null>(null);

  const today = bangkokToday();

  const fetchBoard = useCallback(async () => {
    const ordersRes = await supabase
      .from("orders")
      .select(
        "id, customer_id, customer_name, item_name, job_id, status, payment_status, price, urgent, due_date, branch_id, business_type, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(500);
    if (ordersRes.error) {
      setErrorMessage(ordersRes.error.message);
      setOrders([]);
      return;
    }
    const rows = (ordersRes.data ?? []) as Array<
      Omit<BoardOrder, "phone" | "itemCount" | "technicianIds">
    >;
    const orderIds = rows.map((r) => r.id);

    // Customer phones — only the customers referenced by these orders.
    const customerIds = Array.from(
      new Set(rows.map((r) => r.customer_id).filter((id): id is string => !!id))
    );
    const phoneById: Record<string, string> = {};
    if (customerIds.length > 0) {
      const custRes = await supabase
        .from("customers")
        .select("id, phone")
        .in("id", customerIds);
      for (const c of (custRes.data ?? []) as Array<{
        id: string;
        phone: string | null;
      }>) {
        if (c.phone) phoneById[c.id] = c.phone;
      }
    }

    // Item counts + per-item technicians.
    const itemsByOrder = await fetchOrderItemsForOrders(supabase, orderIds);

    // Technician display names.
    const techRes = await supabase
      .from("technician_profiles")
      .select("id, display_name");
    const techMap: Record<string, string> = {};
    for (const t of (techRes.data ?? []) as Array<{
      id: string;
      display_name: string;
    }>) {
      techMap[t.id] = t.display_name;
    }
    setTechNames(techMap);

    setOrders(
      rows.map((r) => {
        const items = itemsByOrder[r.id] ?? [];
        const technicianIds = Array.from(
          new Set(
            items
              .map((it) => it.assigned_technician_id)
              .filter((id): id is string => !!id)
          )
        );
        return {
          ...r,
          price: Number(r.price ?? 0),
          urgent: Boolean(r.urgent),
          phone: r.customer_id ? phoneById[r.customer_id] ?? null : null,
          // Legacy single-item orders carry no order_items rows → count 1.
          itemCount: items.length > 0 ? items.length : 1,
          technicianIds,
        };
      })
    );
  }, []);

  useEffect(() => {
    void (async () => {
      setIsLoading(true);
      setErrorMessage(null);
      await fetchBoard();
      setIsLoading(false);
    })();
  }, [fetchBoard]);

  const handleUpdateStatus = async (orderId: string, newStatus: string) => {
    setErrorMessage(null);
    const previous = orders;
    const previousStatus =
      previous.find((o) => o.id === orderId)?.status ?? null;
    setOrders((curr) =>
      curr.map((o) => (o.id === orderId ? { ...o, status: newStatus } : o))
    );

    const { error } = await supabase
      .from("orders")
      .update({ status: newStatus })
      .eq("id", orderId);
    if (error) {
      setErrorMessage(error.message);
      setOrders(previous);
      return;
    }

    // Best-effort audit — table may be absent on un-migrated DBs.
    const auditRes = await supabase.from("order_audit_log").insert({
      order_id: orderId,
      action: "status_changed",
      before_value: previousStatus,
      after_value: newStatus,
      changed_by: user?.uid ?? null,
    });
    if (
      auditRes.error &&
      !/column .* does not exist|schema cache|relation .* does not exist/i.test(
        auditRes.error.message
      )
    ) {
      console.warn("[orders] audit write failed", auditRes.error.message);
    }

    const event = mapStatusToLifecycleEvent(previousStatus, newStatus);
    if (event) void triggerLifecycleEvent(event, orderId);
  };

  // ---- Queue counts (computed once over the full list) -------------------
  const counts = useMemo(() => {
    const c: Record<Queue, number> = {
      all: orders.length,
      today: 0,
      overdue: 0,
      urgent: 0,
      ready: 0,
      waiting_payment: 0,
    };
    for (const o of orders) {
      if (o.due_date === today) c.today += 1;
      if (isOverdue(o.status, o.due_date)) c.overdue += 1;
      if (o.urgent && o.status !== "delivered" && o.status !== "cancelled")
        c.urgent += 1;
      if (o.status === "ready-for-pickup") c.ready += 1;
      if (o.payment_status !== "paid" && o.status !== "cancelled")
        c.waiting_payment += 1;
    }
    return c;
  }, [orders, today]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      // Queue filter.
      if (queue === "today" && o.due_date !== today) return false;
      if (queue === "overdue" && !isOverdue(o.status, o.due_date)) return false;
      if (
        queue === "urgent" &&
        !(o.urgent && o.status !== "delivered" && o.status !== "cancelled")
      )
        return false;
      if (queue === "ready" && o.status !== "ready-for-pickup") return false;
      if (
        queue === "waiting_payment" &&
        !(o.payment_status !== "paid" && o.status !== "cancelled")
      )
        return false;

      // Technician filter.
      if (technicianFilter && !o.technicianIds.includes(technicianFilter))
        return false;

      // Free-text search — customer / job id / order id.
      if (q) {
        const hay = [
          o.customer_name,
          o.job_id ?? "",
          o.id.slice(0, 8),
          o.phone ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [orders, queue, technicianFilter, search, today]);

  const technicianOptions = useMemo(
    () =>
      Object.entries(techNames).sort((a, b) => a[1].localeCompare(b[1])),
    [techNames]
  );

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      {/* Header */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-l-4 border-yellow-400 pl-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS
          </p>
          <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900">
            กระดานงานซ่อม
          </h1>
          <p className="text-sm text-gray-600">
            ดูคิวงาน เปลี่ยนสถานะ และติดตามทุกใบงานของสาขา
          </p>
        </div>
        <Link
          href="/intake"
          className="shrink-0 rounded-xl bg-green-700 px-5 py-3 text-center text-sm font-semibold text-white hover:bg-green-800"
        >
          + รับงานใหม่
        </Link>
      </div>

      {errorMessage && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {/* Queue chips */}
      <div className="mb-3 flex flex-wrap gap-2">
        {QUEUES.map((qd) => (
          <button
            key={qd.key}
            type="button"
            onClick={() => setQueue(qd.key)}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
              queue === qd.key
                ? "border-green-700 bg-green-700 text-white"
                : "border-gray-200 bg-white text-gray-700 hover:border-green-300"
            }`}
          >
            {qd.label}
            <span
              className={`ml-1.5 ${
                queue === qd.key ? "text-green-100" : "text-gray-400"
              }`}
            >
              {counts[qd.key]}
            </span>
          </button>
        ))}
      </div>

      {/* Search + technician filter */}
      <div className="mb-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="ค้นหา ลูกค้า / Job ID / เบอร์"
          aria-label="ค้นหาใบงาน"
          autoComplete="off"
          className="rounded-xl border border-gray-200 px-3 py-3 text-base sm:text-sm outline-none focus:ring-2 focus:ring-green-500 sm:col-span-2"
        />
        <select
          value={technicianFilter}
          onChange={(e) => setTechnicianFilter(e.target.value)}
          aria-label="กรองตามช่าง"
          className="rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="">ช่างทุกคน</option>
          {technicianOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {/* Board */}
      {isLoading ? (
        <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center text-gray-500">
          กำลังโหลด...
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center text-gray-500">
          {orders.length === 0
            ? "ยังไม่มีใบงาน — เริ่มที่หน้ารับงาน"
            : "ไม่มีงานในคิวนี้"}
        </div>
      ) : (
        <>
          <p className="mb-2 text-xs text-gray-500">
            แสดง {filtered.length} จาก {orders.length} ใบงาน
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((o) => (
              <OrderCard
                key={o.id}
                order={o}
                techNames={techNames}
                today={today}
                onOpen={() => setDetailOrder(o)}
                onStatusChange={(s) => void handleUpdateStatus(o.id, s)}
              />
            ))}
          </div>
        </>
      )}

      <OrderDetailModal
        order={detailOrder}
        onClose={() => setDetailOrder(null)}
      />
    </div>
  );
}

// ---------- Operations card -------------------------------------------------

function OrderCard({
  order,
  techNames,
  today,
  onOpen,
  onStatusChange,
}: {
  order: BoardOrder;
  techNames: Record<string, string>;
  today: string;
  onOpen: () => void;
  onStatusChange: (status: string) => void;
}) {
  const overdue = isOverdue(order.status, order.due_date);
  const dueToday = order.due_date === today;
  const branch = order.branch_id ? getBranchById(order.branch_id) : null;
  const techLabel =
    order.technicianIds.length === 0
      ? "ยังไม่มอบหมายช่าง"
      : order.technicianIds
          .map((id) => techNames[id] ?? "ช่าง")
          .join(", ");

  return (
    <div
      onClick={onOpen}
      className="cursor-pointer rounded-2xl border border-gray-200 bg-white p-4 shadow-sm hover:border-green-300 hover:shadow-md transition"
    >
      {/* Top row — job id + urgent */}
      <div className="flex items-start justify-between gap-2">
        <p className="font-mono text-sm font-bold text-gray-900">
          {order.job_id ?? `#${order.id.slice(0, 8).toUpperCase()}`}
        </p>
        {order.urgent && (
          <span className="shrink-0 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-700">
            ⚡ ด่วน
          </span>
        )}
      </div>

      {/* Customer */}
      <p className="mt-1 font-semibold text-gray-900 truncate">
        {order.customer_name}
      </p>
      <p className="text-xs text-gray-500">{order.phone ?? "—"}</p>

      {/* Meta line */}
      <p className="mt-2 text-xs text-gray-600">
        {order.itemCount} ชิ้น
        {branch ? ` · ${branch.shortLabel}` : ""}
        {` · ${formatCurrency(order.price)}`}
      </p>
      <p className="mt-0.5 text-xs text-gray-600 truncate">👤 {techLabel}</p>

      {/* Due date */}
      <p
        className={`mt-1 text-xs font-medium ${
          overdue
            ? "text-red-700"
            : dueToday
              ? "text-amber-700"
              : "text-gray-500"
        }`}
      >
        {order.due_date
          ? `กำหนดรับ: ${order.due_date}${
              overdue ? " · เลยกำหนด" : dueToday ? " · วันนี้" : ""
            }`
          : "ไม่ระบุกำหนดรับ"}
      </p>

      {/* Badges */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <OrderStatusBadge status={order.status} size="sm" />
        <PaymentStatusBadge status={order.payment_status} size="sm" />
      </div>

      {/* Actions */}
      <div
        className="mt-3 flex items-center justify-between gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <select
          value={order.status}
          onChange={(e) => onStatusChange(e.target.value)}
          aria-label="เปลี่ยนสถานะ"
          className="min-h-[40px] rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
        >
          {ORDER_OPS_FLOW.map((s) => (
            <option key={s} value={s}>
              {orderStatusLabel(s)}
            </option>
          ))}
          {!ORDER_OPS_FLOW.includes(
            order.status as (typeof ORDER_OPS_FLOW)[number]
          ) && (
            <option value={order.status}>
              {orderStatusLabel(order.status)}
            </option>
          )}
        </select>
        <Link
          href={`/orders/${order.id}/document`}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 text-sm font-medium text-green-700 hover:text-green-800"
        >
          เอกสาร →
        </Link>
      </div>
    </div>
  );
}
