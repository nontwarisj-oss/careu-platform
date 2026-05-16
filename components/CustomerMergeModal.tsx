"use client";

// <CustomerMergeModal> — Store Ops Hardening, duplicate customer merge.
//
// The same person sometimes becomes two customer rows. This folds a
// DUPLICATE into a SURVIVOR: pick both, see a preview of how many
// orders will move, confirm. The actual merge (order reassignment +
// audit + duplicate removal) runs server-side in /api/admin/customers/
// merge — this component only drives it.

import { useEffect, useState } from "react";
import { normalizePhone } from "@/lib/phone";

type CustomerLite = { id: string; name: string; phone: string };

type Preview = {
  ordersToMove: number;
} | null;

export function CustomerMergeModal({
  isOpen,
  customers,
  onClose,
  onMerged,
}: {
  isOpen: boolean;
  customers: CustomerLite[];
  onClose: () => void;
  onMerged: () => void;
}) {
  const [survivor, setSurvivor] = useState<CustomerLite | null>(null);
  const [duplicate, setDuplicate] = useState<CustomerLite | null>(null);
  const [preview, setPreview] = useState<Preview>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Reset whenever the modal opens.
  useEffect(() => {
    if (isOpen) {
      setSurvivor(null);
      setDuplicate(null);
      setPreview(null);
      setError(null);
      setDone(null);
      setBusy(false);
    }
  }, [isOpen]);

  // Pull a preview once both are chosen.
  useEffect(() => {
    if (!survivor || !duplicate || survivor.id === duplicate.id) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const res = await fetch("/api/admin/customers/merge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            survivorId: survivor.id,
            duplicateId: duplicate.id,
            dryRun: true,
          }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          reason?: string;
          ordersToMove?: number;
        };
        if (cancelled) return;
        if (!res.ok || !json.ok) {
          setError(json.reason ?? "ดูตัวอย่างไม่สำเร็จ");
          setPreview(null);
        } else {
          setPreview({ ordersToMove: json.ordersToMove ?? 0 });
        }
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "เครือข่ายขัดข้อง");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [survivor, duplicate]);

  if (!isOpen) return null;

  const sameRow = survivor && duplicate && survivor.id === duplicate.id;

  const handleMerge = async () => {
    if (!survivor || !duplicate || sameRow) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/customers/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          survivorId: survivor.id,
          duplicateId: duplicate.id,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        ordersMoved?: number;
        duplicateRemoved?: boolean;
      };
      if (!res.ok || !json.ok) {
        setError(json.reason ?? "รวมลูกค้าไม่สำเร็จ");
      } else {
        setDone(
          `รวมเรียบร้อย — ย้าย ${json.ordersMoved ?? 0} ใบงาน` +
            (json.duplicateRemoved === false
              ? " (รายชื่อซ้ำถูกปิดการใช้งานแทนการลบ)"
              : "")
        );
        onMerged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "เครือข่ายขัดข้อง");
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="mt-10 w-full max-w-lg rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 p-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">รวมลูกค้าซ้ำ</h2>
            <p className="text-xs text-gray-500">
              ย้ายประวัติทุกใบงานไปยังลูกค้าหลัก แล้วลบรายชื่อซ้ำ
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-100"
          >
            ปิด
          </button>
        </div>

        <div className="space-y-4 p-4">
          {done ? (
            <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-3 text-sm text-green-800">
              {done}
            </div>
          ) : (
            <>
              <Picker
                label="ลูกค้าหลัก (เก็บไว้)"
                customers={customers}
                selected={survivor}
                onSelect={setSurvivor}
              />
              <Picker
                label="รายชื่อซ้ำ (จะถูกลบ)"
                customers={customers}
                selected={duplicate}
                onSelect={setDuplicate}
              />

              {sameRow && (
                <p className="text-sm text-red-600">
                  เลือกลูกค้าคนละรายกัน
                </p>
              )}

              {preview && !sameRow && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  จะย้าย <strong>{preview.ordersToMove}</strong> ใบงานจาก{" "}
                  “{duplicate?.name}” ไปยัง “{survivor?.name}” —
                  แล้วลบรายชื่อซ้ำ การกระทำนี้ย้อนกลับไม่ได้
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </div>
              )}

              <button
                type="button"
                disabled={busy || !survivor || !duplicate || !!sameRow}
                onClick={() => void handleMerge()}
                className="w-full rounded-xl bg-green-700 py-3 text-sm font-semibold text-white hover:bg-green-800 disabled:opacity-50"
              >
                {busy ? "กำลังรวม..." : "ยืนยันรวมลูกค้า"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Picker({
  label,
  customers,
  selected,
  onSelect,
}: {
  label: string;
  customers: CustomerLite[];
  selected: CustomerLite | null;
  onSelect: (c: CustomerLite | null) => void;
}) {
  const [query, setQuery] = useState("");

  const matches = (() => {
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
    <div>
      <p className="mb-1 text-xs font-semibold text-gray-700">{label}</p>
      {selected ? (
        <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-3 py-2">
          <span className="text-sm text-gray-800">
            {selected.name}{" "}
            <span className="text-gray-500">{selected.phone}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              onSelect(null);
              setQuery("");
            }}
            className="text-xs font-semibold text-gray-500 hover:text-gray-700"
          >
            เปลี่ยน
          </button>
        </div>
      ) : (
        <>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาด้วยชื่อหรือเบอร์"
            className="w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
          />
          {query.trim() && matches.length > 0 && (
            <div className="mt-1 divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
              {matches.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  onClick={() => {
                    onSelect(c);
                    setQuery("");
                  }}
                  className="block w-full px-3 py-1.5 text-left hover:bg-green-50"
                >
                  <span className="text-sm text-gray-800">{c.name}</span>{" "}
                  <span className="text-xs text-gray-500">{c.phone}</span>
                </button>
              ))}
            </div>
          )}
          {query.trim() && matches.length === 0 && (
            <p className="mt-1 text-xs text-gray-400">ไม่พบลูกค้า</p>
          )}
        </>
      )}
    </div>
  );
}

export default CustomerMergeModal;
