"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useBranch } from "@/lib/branchContext";
import {
  SERVICES,
  SERVICE_CATEGORIES,
  PROMOTIONS,
  CUSTOMER_TYPES,
  URGENT_MODIFIERS,
  computeDiscount,
  getServiceByCode,
  getPromotionByCode,
  type ServiceCategoryKey,
} from "@/lib/pricing";
import { createSmartOrder } from "@/lib/orderCreate";
import { normalizePhone } from "@/lib/phone";

type Customer = {
  id: string;
  name: string;
  phone: string;
};

type BranchRow = { id: string };

type STATUS = "pending" | "in-progress" | "completed" | "ready-for-pickup";

export type SmartOrderCreatedSummary = {
  orderId: string;
  customerName: string;
  customerPhone: string;
  serviceCategoryLabel: string;
  serviceName: string;
  templateText: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  urgent: boolean;
  urgentFee: number;
  promotionLabel: string;
  discount: number;
  total: number;
  customerTypeLabel: string;
  status: STATUS;
  notes: string;
  branchShortLabel: string;
  branchName: string;
};

interface SmartOrderFormProps {
  /** Variant changes spacing/headlines but the logic is identical. */
  variant?: "intake" | "manage";
  /** Optional callback after a successful create. */
  onCreated?: (summary: SmartOrderCreatedSummary) => void;
}

const NEEDS_QUOTE_TH = "ต้องประเมินราคา";

export function SmartOrderForm({
  variant = "intake",
  onCreated,
}: SmartOrderFormProps) {
  const { branch } = useBranch();

  // ---- Customer ----------------------------------------------------------
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isLoadingCustomers, setIsLoadingCustomers] = useState(true);
  const [customerId, setCustomerId] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [isCreatingNewCustomer, setIsCreatingNewCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [customerType, setCustomerType] = useState<string>("general");

  // ---- Service / job -----------------------------------------------------
  const [category, setCategory] = useState<ServiceCategoryKey | "">("");
  const [serviceCode, setServiceCode] = useState<string>("");
  const [templateText, setTemplateText] = useState<string>("");
  const [templateTouched, setTemplateTouched] = useState(false);
  const [unitPriceInput, setUnitPriceInput] = useState<string>("");
  const [unitPriceTouched, setUnitPriceTouched] = useState(false);
  const [quantity, setQuantity] = useState<string>("1");

  // ---- Modifiers / promo -------------------------------------------------
  const [urgent, setUrgent] = useState(false);
  const [urgentFee, setUrgentFee] = useState<string>("30");
  const [promotionCode, setPromotionCode] = useState<string>("NONE");
  const [manualDiscount, setManualDiscount] = useState<string>("");

  // ---- Misc --------------------------------------------------------------
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<STATUS>("pending");

  // ---- UI state ----------------------------------------------------------
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ---- Data fetch --------------------------------------------------------
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
        if (
          phoneDigits.length >= 3 &&
          normalizePhone(c.phone).includes(phoneDigits)
        )
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

  // Auto-fill template + price when a service is selected
  const selectedService = useMemo(
    () => getServiceByCode(serviceCode),
    [serviceCode]
  );

  useEffect(() => {
    if (!selectedService) return;
    if (!templateTouched) {
      setTemplateText(selectedService.templateTh);
    }
    if (!unitPriceTouched) {
      setUnitPriceInput(
        selectedService.basePrice === null
          ? ""
          : String(selectedService.basePrice)
      );
    }
  }, [selectedService, templateTouched, unitPriceTouched]);

  // ---- Derived totals ----------------------------------------------------
  const filteredServices = useMemo(
    () => SERVICES.filter((s) => !category || s.category === category),
    [category]
  );

  const unitPrice = Math.max(0, Number(unitPriceInput) || 0);
  const numericQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
  const subtotal = unitPrice * numericQuantity;
  const urgentFeeAmount = urgent ? Math.max(0, Number(urgentFee) || 0) : 0;
  const manualDiscountValue =
    promotionCode === "MANUAL" ? Math.max(0, Number(manualDiscount) || 0) : 0;
  const discount = computeDiscount(subtotal, promotionCode, manualDiscountValue);
  const total = Math.max(0, subtotal + urgentFeeAmount - discount);

  const isQuoteOnly =
    selectedService?.basePrice === null && unitPrice === 0;

  const promotion = getPromotionByCode(promotionCode);

  // ---- Handlers ----------------------------------------------------------
  const handleStartNewCustomer = () => {
    setIsCreatingNewCustomer(true);
    const digits = normalizePhone(customerSearch);
    if (digits) setNewCustomerPhone(customerSearch);
    else setNewCustomerName(customerSearch);
  };

  const handleSelectService = (code: string) => {
    setServiceCode(code);
    setTemplateTouched(false);
    setUnitPriceTouched(false);
  };

  const handleSelectCategory = (code: ServiceCategoryKey | "") => {
    setCategory(code);
    setServiceCode("");
    setTemplateText("");
    setTemplateTouched(false);
    setUnitPriceInput("");
    setUnitPriceTouched(false);
  };

  const handleReset = () => {
    setCustomerId("");
    setCustomerSearch("");
    setIsCreatingNewCustomer(false);
    setNewCustomerName("");
    setNewCustomerPhone("");
    setCustomerType("general");
    setCategory("");
    setServiceCode("");
    setTemplateText("");
    setTemplateTouched(false);
    setUnitPriceInput("");
    setUnitPriceTouched(false);
    setQuantity("1");
    setUrgent(false);
    setUrgentFee("30");
    setPromotionCode("NONE");
    setManualDiscount("");
    setNotes("");
    setStatus("pending");
    setErrorMessage(null);
  };

  const handleSubmit = async () => {
    setErrorMessage(null);

    if (!selectedService) {
      setErrorMessage("เลือกบริการ/รายการก่อนบันทึก");
      return;
    }
    if (unitPrice <= 0) {
      setErrorMessage("กรอกราคา (หรือประเมินราคาให้ลูกค้าก่อนบันทึก)");
      return;
    }

    setIsSubmitting(true);

    // Resolve customer (or create a new one).
    let resolvedCustomer = selectedCustomer;
    if (!resolvedCustomer && isCreatingNewCustomer) {
      if (!newCustomerName.trim() || !newCustomerPhone.trim()) {
        setErrorMessage("กรอกชื่อและเบอร์ลูกค้าใหม่");
        setIsSubmitting(false);
        return;
      }
      const phoneDigits = normalizePhone(newCustomerPhone);
      const duplicate = customers.find(
        (c) => normalizePhone(c.phone) === phoneDigits
      );
      if (duplicate) {
        resolvedCustomer = duplicate;
        setCustomerId(duplicate.id);
        setIsCreatingNewCustomer(false);
      } else {
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
          setErrorMessage(
            insert.error?.message ?? "บันทึกลูกค้าใหม่ไม่สำเร็จ"
          );
          setIsSubmitting(false);
          return;
        }
        resolvedCustomer = insert.data as Customer;
        setCustomers((curr) => [...curr, resolvedCustomer as Customer]);
        setCustomerId(resolvedCustomer.id);
      }
    }

    if (!resolvedCustomer) {
      setErrorMessage("เลือกหรือเพิ่มลูกค้าก่อนบันทึก");
      setIsSubmitting(false);
      return;
    }

    const { orderId, error } = await createSmartOrder({
      customerId: resolvedCustomer.id,
      customerName: resolvedCustomer.name,
      customerType,
      branchId: branch.id,
      serviceCategory: selectedService.category,
      serviceCode: selectedService.code,
      serviceName: selectedService.nameTh,
      templateText: templateText || selectedService.templateTh || null,
      quantity: numericQuantity,
      subtotal,
      urgent,
      urgentFee: urgentFeeAmount,
      promotionCode:
        promotionCode === "NONE" ? null : promotionCode,
      discount,
      total,
      notes: notes.trim() || null,
      status,
    });

    if (error || !orderId) {
      setErrorMessage(error ?? "บันทึกใบงานไม่สำเร็จ");
      setIsSubmitting(false);
      return;
    }

    // Fire-and-forget Google Sheet sync. Order is already safely in Supabase
    // at this point — sync failure must NOT block the staff workflow. The
    // /orders/[id]/document page surfaces a manual retry button so the
    // operator can re-sync if this call quietly fails.
    void fetch("/api/sync-order-to-sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId }),
    }).catch(() => {
      // Network errors swallowed intentionally; the manual button is the UX.
    });

    const summary: SmartOrderCreatedSummary = {
      orderId,
      customerName: resolvedCustomer.name,
      customerPhone: resolvedCustomer.phone,
      serviceCategoryLabel:
        SERVICE_CATEGORIES.find((c) => c.code === selectedService.category)
          ?.labelTh ?? selectedService.category,
      serviceName: selectedService.nameTh,
      templateText: templateText || selectedService.templateTh,
      quantity: numericQuantity,
      unitPrice,
      subtotal,
      urgent,
      urgentFee: urgentFeeAmount,
      promotionLabel:
        promotion && promotion.code !== "NONE" ? promotion.nameTh : "ไม่มี",
      discount,
      total,
      customerTypeLabel:
        CUSTOMER_TYPES.find((t) => t.code === customerType)?.nameTh ?? "-",
      status,
      notes: notes.trim(),
      branchShortLabel: branch.shortLabel,
      branchName: branch.name,
    };

    onCreated?.(summary);
    handleReset();
    setIsSubmitting(false);
  };

  // ---- Render ------------------------------------------------------------
  const sectionClass =
    variant === "intake"
      ? "bg-white rounded-2xl border border-gray-200 shadow-sm p-4 mb-4"
      : "bg-white rounded-2xl border border-green-100 shadow-sm p-4 md:p-5 mb-4";

  return (
    <div className="space-y-0">
      {errorMessage && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {/* 1 — Customer */}
      <section className={sectionClass}>
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

        <div className="mt-4">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            ประเภทลูกค้า
          </label>
          <select
            value={customerType}
            onChange={(e) => setCustomerType(e.target.value)}
            className="w-full rounded-xl border border-gray-300 bg-white p-3 outline-none focus:ring-2 focus:ring-green-500"
          >
            {CUSTOMER_TYPES.map((t) => (
              <option key={t.code} value={t.code}>
                {t.nameTh}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* 2 — Service */}
      <section className={sectionClass}>
        <p className="text-xs font-bold uppercase tracking-widest text-green-700 mb-3">
          2 • บริการ / งานซ่อม
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <select
            value={category}
            onChange={(e) =>
              handleSelectCategory(e.target.value as ServiceCategoryKey | "")
            }
            className="rounded-xl border border-gray-300 bg-white p-3 outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">เลือกหมวดบริการ</option>
            {SERVICE_CATEGORIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.labelTh}
              </option>
            ))}
          </select>
          <select
            value={serviceCode}
            onChange={(e) => handleSelectService(e.target.value)}
            disabled={!category}
            className="rounded-xl border border-gray-300 bg-white p-3 outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-60"
          >
            <option value="">เลือกรายการบริการ</option>
            {filteredServices.map((s) => (
              <option key={s.code} value={s.code}>
                {s.nameTh}
                {s.basePrice === null ? " • ประเมินราคา" : ` • ฿${s.basePrice}`}
              </option>
            ))}
          </select>
        </div>

        <textarea
          value={templateText}
          onChange={(e) => {
            setTemplateText(e.target.value);
            setTemplateTouched(true);
          }}
          rows={3}
          placeholder="รายละเอียดงาน (จะกรอกอัตโนมัติเมื่อเลือกบริการ)"
          className="mt-3 w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
        />

        <div className="grid gap-3 md:grid-cols-3 mt-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              ราคาต่อหน่วย (บาท)
            </label>
            <input
              type="number"
              inputMode="decimal"
              value={unitPriceInput}
              onChange={(e) => {
                setUnitPriceInput(e.target.value);
                setUnitPriceTouched(true);
              }}
              placeholder={
                selectedService?.basePrice === null ? NEEDS_QUOTE_TH : "0"
              }
              className="w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
            />
            {isQuoteOnly && (
              <p className="mt-1 text-[11px] text-yellow-700">
                * บริการนี้ต้องประเมินราคาก่อนบันทึก
              </p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              จำนวน
            </label>
            <input
              type="number"
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              สถานะ
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as STATUS)}
              className="w-full rounded-xl border border-gray-300 bg-white p-3 outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="pending">รอดำเนิน</option>
              <option value="in-progress">กำลังซ่อม</option>
              <option value="completed">เสร็จสิ้น</option>
              <option value="ready-for-pickup">พร้อมรับ</option>
            </select>
          </div>
        </div>
      </section>

      {/* 3 — Modifiers + promotion */}
      <section className={sectionClass}>
        <p className="text-xs font-bold uppercase tracking-widest text-green-700 mb-3">
          3 • ส่วนเสริม + โปรโมชัน
        </p>

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
          <div className="grid grid-cols-3 gap-2 mt-2">
            {URGENT_MODIFIERS.map((m) => (
              <button
                type="button"
                key={m.code}
                onClick={() => setUrgentFee(String(m.fee))}
                className={`rounded-xl border px-2 py-2 text-sm font-medium ${
                  Number(urgentFee) === m.fee
                    ? "bg-green-700 border-green-700 text-white"
                    : "bg-white border-gray-300 text-gray-700"
                }`}
              >
                +฿{m.fee}
              </button>
            ))}
            <input
              type="number"
              inputMode="decimal"
              value={urgentFee}
              onChange={(e) => setUrgentFee(e.target.value)}
              placeholder="เอง"
              className="rounded-xl border border-gray-300 p-2 outline-none focus:ring-2 focus:ring-green-500 text-sm"
            />
          </div>
        )}

        <div className="mt-3">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            โปรโมชัน
          </label>
          <select
            value={promotionCode}
            onChange={(e) => setPromotionCode(e.target.value)}
            className="w-full rounded-xl border border-gray-300 bg-white p-3 outline-none focus:ring-2 focus:ring-green-500"
          >
            {PROMOTIONS.map((p) => (
              <option key={p.code} value={p.code}>
                {p.nameTh}
              </option>
            ))}
          </select>
          {promotionCode === "MANUAL" && (
            <input
              type="number"
              inputMode="decimal"
              value={manualDiscount}
              onChange={(e) => setManualDiscount(e.target.value)}
              placeholder="ส่วนลด (บาท)"
              className="mt-2 w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
            />
          )}
        </div>
      </section>

      {/* 4 — Summary + notes */}
      <section className={sectionClass}>
        <p className="text-xs font-bold uppercase tracking-widest text-green-700 mb-3">
          4 • สรุปยอด
        </p>
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm space-y-1.5">
          <div className="flex justify-between">
            <span className="text-gray-600">
              ยอดก่อนส่วนลด ({numericQuantity} × {formatCurrency(unitPrice)})
            </span>
            <span className="text-gray-800">{formatCurrency(subtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">ค่างานด่วน</span>
            <span className="text-gray-800">
              {formatCurrency(urgentFeeAmount)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">
              ส่วนลด
              {promotion && promotion.code !== "NONE"
                ? ` (${promotion.nameTh})`
                : ""}
            </span>
            <span className="text-gray-800">-{formatCurrency(discount)}</span>
          </div>
          <div className="flex justify-between items-center pt-1 border-t border-gray-200">
            <span className="text-gray-700 font-medium">ยอดรวมสุทธิ</span>
            <span className="text-2xl font-bold text-green-700">
              {formatCurrency(total)}
            </span>
          </div>
        </div>

        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="บันทึกเพิ่มเติม (เช่น สีด้าย, รหัสตู้รับ)"
          className="mt-3 w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
        />
      </section>

      <button
        onClick={() => void handleSubmit()}
        disabled={
          isSubmitting ||
          (!selectedCustomer && !isCreatingNewCustomer) ||
          !selectedService ||
          unitPrice <= 0
        }
        className="w-full bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white font-semibold py-3.5 rounded-xl shadow-sm"
      >
        {isSubmitting ? "กำลังบันทึก..." : "บันทึกใบงาน"}
      </button>
    </div>
  );
}

export default SmartOrderForm;
