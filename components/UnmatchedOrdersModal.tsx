"use client";

// Unmatched-order resolver — Store Ops Hardening (customer data integrity).
//
// Orders that are not linked to a customer never count toward that
// customer's visit count or spend. This modal lists them and lets a staff
// member link each one to the right customer in a couple of taps.
//
// Source of truth: GET /api/customers/unmatched-orders. That route runs
// the SAME id → phone → name matcher the /customers warning uses, so the
// modal and the warning always agree. (The old modal queried only
// `customer_id IS NULL`, missing orphan/stale customer_id rows — which is
// why the warning said "11 of 14" while this modal said "nothing to do".)
//
// Writes only orders.customer_id (orders runs with RLS disabled — same
// path the operations board uses for status changes).

import { useCallback, useEffect, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { normalizePhone } from "@/lib/phone";

type CustomerLite = { id: string; name: string; phone: string };

type UnmatchedReason =
  | "null_customer_id"
  | "orphan_customer_id"
  | "no_match"
  | "ambiguous_match";

type UnlinkedOrder = {
  id: string;
  job_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  item_name: string;
  price: number;
  created_at: string;
  branch_id: string | null;
  reason: UnmatchedReason;
};

// Thai labels for the per-order reason chip.
const REASON_LABELS: Record<UnmatchedReason, string> = {
  null_customer_id: "ยังไม่ผูกรหัสลูกค้า",
  orphan_customer_id: "รหัสลูกค้าไม่ถูกต้อง",
  no_match: "หาลูกค้าที่ตรงกันไม่พบ",
  ambiguous_match: "ตรงกับลูกค้าหลายราย",
};

export function UnmatchedOrdersModal({
  isOpen,
  customers,
  onClose,
  onResolved,
}: {
  isOpen: boolean;
  customers: CustomerLite[];
  onClose: () => void;
  /** Called after at least one order was linked, so the parent can refresh. */
  onResolved: () => void;
}) {
  const [orders, setOrders] = useState<UnlinkedOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkedCount, setLinkedCount] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/customers/unmatched-orders");
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        orders?: UnlinkedOrder[];
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `โหลดข้อมูลไม่สำเร็จ (HTTP ${res.status})`);
        setOrders([]);
      } else {
        setOrders(
          (json.orders ?? []).map((o) => ({
            id: String(o.id),
            job_id: o.job_id ?? null,
            customer_name: o.customer_name ?? "",
            customer_phone: o.customer_phone ?? null,
            item_name: o.item_name ?? "",
            price: Number(o.price ?? 0),
            created_at: o.created_at,
            branch_id: o.branch_id ?? null,
            reason: o.reason,
          }))
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      setOrders([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setLinkedCount(0);
      void load();
    }
  }, [isOpen, load]);

  if (!isOpen) return null;

  const handleLink = async (orderId: string, customerId: string) => {
    setError(null);
    const res = await supabase
      .from("orders")
      .update({ customer_id: customerId })
      .eq("id", orderId);
    if (res.error) {
      setError(res.error.message);
      return;
    }
    setOrders((curr) => curr.filter((o) => o.id !== orderId));
    setLinkedCount((n) => n + 1);
  };

  const handleClose = () => {
    if (linkedCount > 0) onResolved();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="mt-8 w-full max-w-2xl rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 p-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">
              จับคู่ใบงานกับลูกค้า
            </h2>
            <p className="text-xs text-gray-500">
              ใบงานที่ยังไม่ผูกกับลูกค้า — เลือกลูกค้าที่ถูกต้องเพื่อให้นับยอดได้
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-100"
          >
            ปิด
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {error && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          {linkedCount > 0 && (
            <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
              เชื่อมแล้ว {linkedCount} ใบงาน
            </div>
          )}
          {loading ? (
            <p className="py-8 text-center text-gray-500">กำลังโหลด...</p>
          ) : orders.length === 0 ? (
            <p className="py-8 text-center text-gray-500">
              ไม่มีใบงานที่ค้างจับคู่ — ข้อมูลครบแล้ว
            </p>
          ) : (
            <div className="space-y-2">
              {orders.map((o) => (
                <ResolverRow
                  key={o.id}
                  order={o}
                  customers={customers}
                  onLink={(customerId) => void handleLink(o.id, customerId)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ResolverRow({
  order,
  customers,
  onLink,
}: {
  order: UnlinkedOrder;
  customers: CustomerLite[];
  onLink: (customerId: string) => void;
}) {
  // Seed the search with the order's phone (if any) then its stored name —
  // the likely match surfaces without the operator typing anything.
  const [query, setQuery] = useState(
    order.customer_phone?.trim() || order.customer_name || ""
  );
  const [picked, setPicked] = useState<CustomerLite | null>(null);

  const matches = (() => {
    if (picked) return [];
    const raw = query.trim();
    if (!raw) return [];
    const lower = raw.toLowerCase();
    const phone = normalizePhone(raw);
    return customers
      .filter((c) => {
        if (phone.length >= 3 && normalizePhone(c.phone).includes(phone))
          return true;
        return c.name.toLowerCase().includes(lower);
      })
      .slice(0, 5);
  })();

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-xs font-bold text-gray-700">
            {order.job_id ?? `#${order.id.slice(0, 8).toUpperCase()}`}
          </p>
          <p className="text-sm font-medium text-gray-900 truncate">
            {order.customer_name || "(ไม่มีชื่อ)"}
          </p>
          <p className="text-xs text-gray-500">
            {order.item_name} · {formatCurrency(order.price)} ·{" "}
            {new Date(order.created_at).toLocaleDateString("th-TH")}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-yellow-300 bg-yellow-50 px-2 py-0.5 text-[10px] font-semibold text-yellow-800">
          {REASON_LABELS[order.reason]}
        </span>
      </div>

      {picked ? (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
          <span className="text-sm text-gray-800">
            → {picked.name}{" "}
            <span className="text-gray-500">{picked.phone}</span>
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="text-xs font-semibold text-gray-500 hover:text-gray-700"
            >
              เปลี่ยน
            </button>
            <button
              type="button"
              onClick={() => onLink(picked.id)}
              className="rounded-lg bg-green-700 px-3 py-1 text-xs font-semibold text-white hover:bg-green-800"
            >
              เชื่อมโยง
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาลูกค้าด้วยชื่อหรือเบอร์"
            className="w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
          />
          {query.trim() && matches.length > 0 && (
            <div className="mt-1 divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
              {matches.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  onClick={() => setPicked(c)}
                  className="block w-full px-3 py-1.5 text-left hover:bg-green-50"
                >
                  <span className="text-sm text-gray-800">{c.name}</span>{" "}
                  <span className="text-xs text-gray-500">{c.phone}</span>
                </button>
              ))}
            </div>
          )}
          {query.trim() && matches.length === 0 && (
            <p className="mt-1 text-xs text-gray-400">ไม่พบลูกค้าที่ตรงกัน</p>
          )}
        </div>
      )}
    </div>
  );
}

export default UnmatchedOrdersModal;
