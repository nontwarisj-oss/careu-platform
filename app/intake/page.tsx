"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useBranch } from "@/lib/branchContext";
import { BrandLogo } from "@/components/BrandLogo";

type Customer = {
  id: string;
  name: string;
  phone: string;
};

type BranchRow = { id: string };

type CreatedSummary = {
  orderId: string;
  customerName: string;
  customerPhone: string;
  itemName: string;
  totalPrice: number;
  status: string;
  branchShortLabel: string;
  branchName: string;
  urgent: boolean;
  urgentFee: number;
};

function normalizePhone(value: string): string {
  return (value ?? "").replace(/\D/g, "");
}

/**
 * Insert order with the intake extension schema (urgent / urgent_fee / notes /
 * branch_id columns + price already includes the urgent fee). Falls back to the
 * legacy column set if the migration hasn't been applied yet, so the form keeps
 * working — urgent is appended to item_name as a " [ด่วน]" suffix in that case.
 */
async function createIntakeOrder(payload: {
  customerId: string;
  customerName: string;
  itemName: string;
  basePrice: number;
  status: string;
  urgent: boolean;
  urgentFee: number;
  notes: string;
  branchId: string;
}): Promise<{ orderId: string | null; error: string | null }> {
  const totalPrice =
    payload.basePrice + (payload.urgent ? payload.urgentFee : 0);

  const base = {
    customer_id: payload.customerId,
    customer_name: payload.customerName,
    item_name: payload.itemName,
    price: totalPrice,
    status: payload.status,
  };

  const extended = {
    ...base,
    urgent: payload.urgent,
    urgent_fee: payload.urgent ? payload.urgentFee : 0,
    notes: payload.notes || null,
    branch_id: payload.branchId,
  };

  const first = await supabase
    .from("orders")
    .insert(extended)
    .select("id")
    .maybeSingle();

  if (!first.error && first.data) {
    return { orderId: String((first.data as { id: string }).id), error: null };
  }

  const looksLikeMissingColumn =
    first.error &&
    /column .* does not exist|could not find.*column|cache.*schema/i.test(
      first.error.message
    );

  if (!looksLikeMissingColumn) {
    return { orderId: null, error: first.error?.message ?? "Insert failed" };
  }

  // Legacy fallback — preserve urgent intent in the item name.
  const legacy = {
    ...base,
    item_name:
      payload.itemName + (payload.urgent ? " [ด่วน]" : ""),
  };
  const second = await supabase
    .from("orders")
    .insert(legacy)
    .select("id")
    .maybeSingle();

  if (second.error || !second.data) {
    return { orderId: null, error: second.error?.message ?? "Insert failed" };
  }
  return { orderId: String((second.data as { id: string }).id), error: null };
}

export default function IntakePage() {
  const { branch } = useBranch();
  const [customers, setCustomers] = useState<Customer[]>([]);

  // Customer step
  const [customerId, setCustomerId] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [isCreatingNewCustomer, setIsCreatingNewCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");

  // Job step
  const [itemName, setItemName] = useState("");
  const [price, setPrice] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [urgentFee, setUrgentFee] = useState("30");
  const [notes, setNotes] = useState("");

  // Media (placeholder — actual upload happens in a later phase)
  const [mediaFiles, setMediaFiles] = useState<File[]>([]);

  // UI state
  const [isLoadingCustomers, setIsLoadingCustomers] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<CreatedSummary | null>(null);

  const fetchCustomers = useCallback(async () => {
    setIsLoadingCustomers(true);
    const { data, error } = await supabase
      .from("customers")
      .select("id, name, phone")
      .order("name", { ascending: true });
    if (error) {
      setErrorMessage(error.message);
      setCustomers([]);
    } else {
      setCustomers((data ?? []) as Customer[]);
    }
    setIsLoadingCustomers(false);
  }, []);

  useEffect(() => {
    void fetchCustomers();
  }, [fetchCustomers]);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId) ?? null,
    [customers, customerId]
  );

  const customerMatches = useMemo(() => {
    const raw = customerSearch.trim();
    if (!raw || selectedCustomer || isCreatingNewCustomer) return [];
    const lower = raw.toLowerCase();
    const phoneDigits = normalizePhone(raw);
    return customers
      .filter((c) => {
        if (phoneDigits.length >= 3 && normalizePhone(c.phone).includes(phoneDigits))
          return true;
        return c.name.toLowerCase().includes(lower);
      })
      .slice(0, 6);
  }, [customers, customerSearch, selectedCustomer, isCreatingNewCustomer]);

  const exactPhoneMatch = useMemo(() => {
    const digits = normalizePhone(customerSearch);
    if (digits.length < 9) return null;
    return customers.find((c) => normalizePhone(c.phone) === digits) ?? null;
  }, [customers, customerSearch]);

  useEffect(() => {
    if (exactPhoneMatch && !customerId) {
      setCustomerId(exactPhoneMatch.id);
    }
  }, [exactPhoneMatch, customerId]);

  const handleStartNewCustomer = () => {
    setIsCreatingNewCustomer(true);
    const digits = normalizePhone(customerSearch);
    if (digits) setNewCustomerPhone(customerSearch);
    else setNewCustomerName(customerSearch);
  };

  const handleSubmit = async () => {
    setErrorMessage(null);

    // Resolve / create customer.
    let resolvedCustomer = selectedCustomer;
    if (!resolvedCustomer && isCreatingNewCustomer) {
      if (!newCustomerName.trim() || !newCustomerPhone.trim()) {
        setErrorMessage("กรอกชื่อและเบอร์ลูกค้าใหม่");
        return;
      }
      const phoneDigits = normalizePhone(newCustomerPhone);
      const duplicate = customers.find(
        (c) => normalizePhone(c.phone) === phoneDigits
      );
      if (duplicate) {
        // Auto-select the existing customer rather than creating a duplicate.
        resolvedCustomer = duplicate;
        setCustomerId(duplicate.id);
        setIsCreatingNewCustomer(false);
      }
    }

    if (!itemName.trim() || !price) {
      setErrorMessage("กรอกรายการงานและราคา");
      return;
    }
    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      setErrorMessage("ราคาต้องเป็นตัวเลขมากกว่าหรือเท่ากับ 0");
      return;
    }
    const numericUrgentFee = urgent ? Math.max(0, Number(urgentFee) || 0) : 0;

    setIsSubmitting(true);

    if (!resolvedCustomer && isCreatingNewCustomer) {
      const { data: branches, error: branchError } = await supabase
        .from("branches")
        .select("id")
        .limit(1);
      if (branchError || !branches?.[0]) {
        setErrorMessage(
          branchError?.message ?? "ยังไม่มีสาขาในระบบ ติดต่อทีมพัฒนา"
        );
        setIsSubmitting(false);
        return;
      }
      const branchRow = branches[0] as BranchRow;
      const insert = await supabase
        .from("customers")
        .insert({
          branch_id: branchRow.id,
          name: newCustomerName.trim(),
          phone: newCustomerPhone.trim(),
          email: "N/A",
          address: "N/A",
          notes: null,
        })
        .select("id, name, phone")
        .single();
      if (insert.error || !insert.data) {
        setErrorMessage(insert.error?.message ?? "บันทึกลูกค้าใหม่ไม่สำเร็จ");
        setIsSubmitting(false);
        return;
      }
      resolvedCustomer = insert.data as Customer;
      setCustomers((curr) => [...curr, resolvedCustomer as Customer]);
      setCustomerId(resolvedCustomer.id);
    }

    if (!resolvedCustomer) {
      setErrorMessage("เลือกหรือเพิ่มลูกค้าก่อนบันทึก");
      setIsSubmitting(false);
      return;
    }

    const { orderId, error } = await createIntakeOrder({
      customerId: resolvedCustomer.id,
      customerName: resolvedCustomer.name,
      itemName: itemName.trim(),
      basePrice: numericPrice,
      status: "pending",
      urgent,
      urgentFee: numericUrgentFee,
      notes: notes.trim(),
      branchId: branch.id,
    });

    if (error || !orderId) {
      setErrorMessage(error ?? "บันทึกใบงานไม่สำเร็จ");
      setIsSubmitting(false);
      return;
    }

    setConfirmation({
      orderId,
      customerName: resolvedCustomer.name,
      customerPhone: resolvedCustomer.phone,
      itemName: itemName.trim(),
      totalPrice: numericPrice + numericUrgentFee,
      status: "pending",
      branchShortLabel: branch.shortLabel,
      branchName: branch.name,
      urgent,
      urgentFee: numericUrgentFee,
    });
    setIsSubmitting(false);
  };

  const resetForm = () => {
    setCustomerId("");
    setCustomerSearch("");
    setIsCreatingNewCustomer(false);
    setNewCustomerName("");
    setNewCustomerPhone("");
    setItemName("");
    setPrice("");
    setUrgent(false);
    setUrgentFee("30");
    setNotes("");
    setMediaFiles([]);
    setErrorMessage(null);
    setConfirmation(null);
  };

  // ---- Confirmation screen ------------------------------------------------
  if (confirmation) {
    return (
      <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
        <div className="mx-auto w-full max-w-md">
          <div className="bg-white rounded-2xl shadow-md border border-green-100 overflow-hidden">
            <div
              className={`bg-gradient-to-r ${branch.accentClass} px-5 py-4 flex items-center gap-3 border-b-4 border-yellow-400 text-white`}
            >
              <BrandLogo size="md" variant="onColor" />
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-widest text-yellow-200 font-semibold">
                  รับงานสำเร็จ
                </p>
                <p className="text-base font-bold leading-tight truncate">
                  {confirmation.branchShortLabel}
                </p>
                <p className="text-[11px] text-white/80 truncate">
                  {confirmation.branchName}
                </p>
              </div>
            </div>

            <div className="p-5 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">เลขที่ใบงาน</span>
                <span className="font-mono">
                  #{confirmation.orderId.slice(0, 8).toUpperCase()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">ลูกค้า</span>
                <span className="font-medium text-gray-800">
                  {confirmation.customerName}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">เบอร์</span>
                <span className="text-gray-800">
                  {confirmation.customerPhone || "-"}
                </span>
              </div>
              <div className="border-t border-dashed border-gray-200 my-2" />
              <div className="flex justify-between">
                <span className="text-gray-500">รายการ</span>
                <span className="text-gray-800 text-right max-w-[60%] break-words">
                  {confirmation.itemName}
                </span>
              </div>
              {confirmation.urgent && (
                <div className="flex justify-between">
                  <span className="text-gray-500">ค่างานด่วน</span>
                  <span className="text-gray-800">
                    {formatCurrency(confirmation.urgentFee)}
                  </span>
                </div>
              )}
              <div className="flex justify-between items-center pt-2 border-t border-gray-200 mt-2">
                <span className="text-gray-600 font-medium">ยอดรวมสุทธิ</span>
                <span className="text-2xl font-bold text-green-700">
                  {formatCurrency(confirmation.totalPrice)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">สถานะ</span>
                <span className="px-3 py-0.5 rounded-full bg-yellow-100 text-yellow-800 text-xs font-medium">
                  รอดำเนิน
                </span>
              </div>
            </div>

            <div className="bg-yellow-50 border-t border-yellow-200 px-5 py-4 text-center">
              <p className="text-sm font-medium text-gray-700">ขอบคุณที่ใช้บริการ</p>
              <p className="text-xs text-green-700 mt-1 italic">{branch.tagline}</p>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-2">
            <button
              onClick={resetForm}
              className="w-full bg-green-700 hover:bg-green-800 text-white font-semibold py-3 rounded-xl"
            >
              รับงานใหม่
            </button>
            <Link
              href="/orders"
              className="w-full text-center border border-green-600 text-green-700 hover:bg-green-50 font-semibold py-3 rounded-xl"
            >
              ดูรายการคำสั่งซ่อม
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ---- Intake form --------------------------------------------------------
  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/50 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto w-full max-w-lg">
        <div className="mb-5 border-l-4 border-yellow-400 pl-4">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-green-700">
            CareU OPS
          </p>
          <h1 className="text-2xl md:text-3xl font-extrabold text-gray-900">
            รับงานหน้าร้าน
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            กรอกข้อมูลลูกค้าและงานซ่อม แล้วบันทึกเพื่อสร้างใบงาน
          </p>
        </div>

        {/* Branch chip (read-only — change via sidebar) */}
        <div className="mb-4 flex items-center gap-3 bg-white border border-green-100 rounded-2xl px-4 py-3 shadow-sm">
          <BrandLogo size="sm" variant="onLight" />
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-gray-500">
              สาขาที่รับงาน
            </p>
            <p className="text-sm font-semibold text-gray-800 truncate">
              {branch.shortLabel}
            </p>
            <p className="text-[11px] text-gray-500 truncate">{branch.address}</p>
          </div>
        </div>

        {errorMessage && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMessage}
          </div>
        )}

        {/* Customer */}
        <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 mb-4">
          <p className="text-xs font-bold uppercase tracking-widest text-green-700 mb-3">
            1 • ลูกค้า
          </p>

          {selectedCustomer ? (
            <div className="flex items-center justify-between border border-green-200 bg-green-50 rounded-xl p-3">
              <div className="min-w-0">
                <p className="font-medium text-gray-800 truncate">
                  {selectedCustomer.name}
                </p>
                <p className="text-sm text-gray-600">{selectedCustomer.phone}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCustomerId("");
                  setCustomerSearch("");
                }}
                className="text-sm text-green-700 hover:text-green-800 font-medium"
              >
                เปลี่ยน
              </button>
            </div>
          ) : isCreatingNewCustomer ? (
            <div className="space-y-3">
              <input
                type="text"
                value={newCustomerName}
                onChange={(e) => setNewCustomerName(e.target.value)}
                placeholder="ชื่อลูกค้า"
                className="w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
              />
              <input
                type="tel"
                inputMode="tel"
                value={newCustomerPhone}
                onChange={(e) => setNewCustomerPhone(e.target.value)}
                placeholder="เบอร์โทร"
                className="w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
              />
              <p className="text-[11px] text-gray-500">
                อีเมล/ที่อยู่จะถูกเก็บเป็น &quot;N/A&quot; โดยอัตโนมัติ
              </p>
              <button
                type="button"
                onClick={() => {
                  setIsCreatingNewCustomer(false);
                  setNewCustomerName("");
                  setNewCustomerPhone("");
                }}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                ย้อนกลับไปค้นหาลูกค้า
              </button>
            </div>
          ) : (
            <>
              <input
                type="search"
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                placeholder={
                  isLoadingCustomers
                    ? "กำลังโหลดลูกค้า..."
                    : "ค้นหาด้วยเบอร์โทรหรือชื่อ"
                }
                disabled={isLoadingCustomers}
                className="w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
              />
              {customerSearch.trim() && customerMatches.length > 0 && (
                <div className="mt-2 border border-gray-200 rounded-xl bg-white divide-y divide-gray-100 max-h-56 overflow-y-auto">
                  {customerMatches.map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      onClick={() => {
                        setCustomerId(c.id);
                        setCustomerSearch("");
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-green-50"
                    >
                      <p className="font-medium text-gray-800">{c.name}</p>
                      <p className="text-sm text-gray-500">{c.phone}</p>
                    </button>
                  ))}
                </div>
              )}
              {customerSearch.trim() && customerMatches.length === 0 && (
                <p className="mt-2 text-xs text-gray-500">
                  ไม่พบลูกค้าที่ตรงกัน
                </p>
              )}
              <button
                type="button"
                onClick={handleStartNewCustomer}
                className="mt-3 w-full border border-dashed border-green-500 text-green-700 hover:bg-green-50 font-semibold rounded-xl py-2.5"
              >
                + เพิ่มลูกค้าใหม่
              </button>
            </>
          )}
        </section>

        {/* Job */}
        <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 mb-4">
          <p className="text-xs font-bold uppercase tracking-widest text-green-700 mb-3">
            2 • งานซ่อม
          </p>
          <div className="space-y-3">
            <input
              type="text"
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              placeholder="รายการ / รายละเอียดงานซ่อม"
              className="w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
            />
            <input
              type="number"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="ราคา (บาท)"
              className="w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
            />

            <label className="flex items-center justify-between gap-3 bg-yellow-50 border border-yellow-200 rounded-xl px-3 py-2.5">
              <span className="text-sm font-medium text-gray-800">งานด่วน</span>
              <input
                type="checkbox"
                checked={urgent}
                onChange={(e) => setUrgent(e.target.checked)}
                className="w-5 h-5 accent-green-700"
              />
            </label>
            {urgent && (
              <input
                type="number"
                inputMode="decimal"
                value={urgentFee}
                onChange={(e) => setUrgentFee(e.target.value)}
                placeholder="ค่างานด่วน (บาท)"
                className="w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
              />
            )}

            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="บันทึก (เช่น จุดที่ขาด, รุ่นผ้า)"
              className="w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        </section>

        {/* Media */}
        <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 mb-4">
          <p className="text-xs font-bold uppercase tracking-widest text-green-700 mb-3">
            3 • ภาพ / วิดีโอ / ใบรับงาน
          </p>
          <input
            type="file"
            accept="image/*,video/*,application/pdf"
            multiple
            capture="environment"
            onChange={(e) => {
              const list = e.target.files;
              if (!list) return;
              setMediaFiles(Array.from(list));
            }}
            className="block w-full text-sm text-gray-700 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
          />
          {mediaFiles.length > 0 ? (
            <ul className="mt-2 text-xs text-gray-600 space-y-1">
              {mediaFiles.map((f) => (
                <li key={f.name} className="truncate">
                  • {f.name}
                </li>
              ))}
              <li className="text-yellow-700">
                * จะแนบไฟล์เข้ากับใบงานเมื่อระบบ Supabase Storage พร้อมใช้งาน
              </li>
            </ul>
          ) : (
            <p className="mt-2 text-xs text-gray-500">
              ยังไม่มีไฟล์แนบ — รองรับภาพ/วิดีโอ/PDF
            </p>
          )}
        </section>

        <button
          onClick={() => void handleSubmit()}
          disabled={
            isSubmitting ||
            (!selectedCustomer && !isCreatingNewCustomer) ||
            !itemName.trim() ||
            !price
          }
          className="w-full bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white font-semibold py-3.5 rounded-xl shadow-sm"
        >
          {isSubmitting ? "กำลังบันทึก..." : "บันทึกใบงาน"}
        </button>
      </div>
    </div>
  );
}
