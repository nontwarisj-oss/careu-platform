"use client";

// Multi-item repair intake — Store Ops Hardening Phase A.
//
// One ticket = one public.orders header + N public.order_items rows.
// The header carries the customer / branch / job_id / grand total; each
// item carries its own service, price, urgent flag, due date, notes, and
// (optional) technician.
//
// Reuses the proven order libs: createSmartOrder (4-tier header insert
// with job_id handling) + insertOrderItems (child rows). Legacy single-
// item orders are unaffected — this only changes how NEW orders are
// captured.

import { useCallback, useEffect, useMemo, useState } from "react";
import supabase from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useBranch } from "@/lib/branchContext";
import {
  SERVICE_CATEGORIES,
  CUSTOMER_TYPES,
  type ServiceCategoryKey,
  type ServiceItem,
} from "@/lib/pricing";
import { fetchPricingCatalog } from "@/lib/pricingDb";
import {
  createSmartOrder,
  checkJobIdAvailability,
  JOB_ID_CHECK_ERROR_MESSAGE,
  type BusinessType,
  type JobIdCheckState,
} from "@/lib/orderCreate";
import {
  insertOrderItems,
  computeLineTotal,
  type OrderItemInput,
} from "@/lib/orderItems";
import {
  fetchActiveTechnicians,
  type TechnicianProfile,
} from "@/lib/technicianService";
import { triggerLifecycleEvent } from "@/lib/lifecycleClient";
import { normalizePhone } from "@/lib/phone";
import { normalizeJobId } from "@/lib/jobId";
import { useAuth } from "@/lib/authContext";
import { useRole } from "@/lib/roleContext";
import { canChooseAnotherBranch } from "@/lib/permissions";
import { branches as ALL_BRANCHES } from "@/lib/brandConfig";
import { OrderItemImages } from "@/components/OrderItemImages";

type Customer = { id: string; name: string; phone: string };

const OTHER_CODE = "__OTHER__";
const DEFAULT_URGENT_FEE = 30;

export type IntakeCreatedSummary = {
  orderId: string;
  itemCount: number;
  total: number;
  customerName: string;
};

/** One garment/item being captured (pre-persistence form state). */
type DraftItem = {
  localId: string;
  category: ServiceCategoryKey | "";
  serviceCode: string;
  customName: string;
  detail: string;
  unitPrice: string;
  quantity: string;
  urgent: boolean;
  urgentFee: string;
  dueDate: string;
  technicianId: string;
  technicianNote: string;
  customerNote: string;
  imagePaths: string[];
};

function makeEmptyItem(): DraftItem {
  return {
    localId:
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `item-${Math.random().toString(36).slice(2)}`,
    category: "",
    serviceCode: "",
    customName: "",
    detail: "",
    unitPrice: "",
    quantity: "1",
    urgent: false,
    urgentFee: String(DEFAULT_URGENT_FEE),
    dueDate: "",
    technicianId: "",
    technicianNote: "",
    customerNote: "",
    imagePaths: [],
  };
}

/** Resolve a draft item's effective service name/category/code. */
function resolveService(
  draft: DraftItem,
  catalog: ServiceItem[]
): { name: string; category: string; code: string | null } {
  if (draft.serviceCode === OTHER_CODE) {
    return {
      name: draft.customName.trim(),
      category: draft.category || "special",
      code: OTHER_CODE,
    };
  }
  const svc = catalog.find((s) => s.code === draft.serviceCode);
  return {
    name: svc?.nameTh ?? "",
    category: (svc?.category ?? draft.category) || "",
    code: svc?.code ?? null,
  };
}

function draftLineTotal(draft: DraftItem): number {
  return computeLineTotal({
    quantity: Math.max(1, Math.floor(Number(draft.quantity) || 1)),
    unitPrice: Math.max(0, Number(draft.unitPrice) || 0),
    urgent: draft.urgent,
    urgentFee: Math.max(0, Number(draft.urgentFee) || 0),
  });
}

export function IntakeOrderForm({
  onCreated,
}: {
  onCreated?: (summary: IntakeCreatedSummary) => void;
}) {
  const { branch, setBranchId } = useBranch();
  const { user } = useAuth();
  const { role } = useRole();
  const canOverrideBranch = canChooseAnotherBranch(role);

  // ---- Customer ----------------------------------------------------------
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [isCreatingNewCustomer, setIsCreatingNewCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [customerType, setCustomerType] = useState("general");

  // ---- Business type + job id -------------------------------------------
  const [businessType, setBusinessTypeState] = useState<BusinessType>(
    branch.brand === "ezy" ? "ezy_repair" : "care_u"
  );
  const [businessTypeTouched, setBusinessTypeTouched] = useState(false);
  const [careUJobId, setCareUJobId] = useState("");
  useEffect(() => {
    if (businessTypeTouched) return;
    setBusinessTypeState(branch.brand === "ezy" ? "ezy_repair" : "care_u");
  }, [branch.brand, businessTypeTouched]);

  // Live Job ID duplicate check (Care U only). Debounced 400ms; the
  // shared checkJobIdAvailability helper POSTs /api/orders/check-job-id
  // so the lookup runs SERVER-SIDE with the service-role client — the
  // browser Supabase client cannot SELECT `orders` under RLS, which
  // was the production failure. The save-time guard uses the SAME
  // helper, so the live result and the save decision can never
  // disagree. A failed lookup resolves to "error" (amber) — never a
  // misleading "duplicate". Ezy Repair auto-generates its Job ID, so
  // it is skipped (no request).
  const [jobIdCheck, setJobIdCheck] = useState<JobIdCheckState>("idle");
  useEffect(() => {
    if (businessType !== "care_u") {
      setJobIdCheck("idle");
      return;
    }
    const normalized = normalizeJobId(careUJobId);
    if (!normalized) {
      // Empty/invalid Job ID → idle. Bail before the probe so the
      // field never flickers through "checking" or lands on a stale
      // green state.
      setJobIdCheck("idle");
      return;
    }
    setJobIdCheck("checking");
    let cancelled = false;
    const timer = setTimeout(async () => {
      const state = await checkJobIdAvailability(
        normalized,
        branch.id,
        "care_u"
      );
      if (!cancelled) setJobIdCheck(state);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [careUJobId, businessType, branch.id]);

  // ---- Items -------------------------------------------------------------
  const [items, setItems] = useState<DraftItem[]>([makeEmptyItem()]);
  const [orderNote, setOrderNote] = useState("");
  const [discountInput, setDiscountInput] = useState("");

  // ---- Catalog + technicians --------------------------------------------
  const [catalog, setCatalog] = useState<ServiceItem[]>([]);
  const [technicians, setTechnicians] = useState<TechnicianProfile[]>([]);

  // ---- UI ----------------------------------------------------------------
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ----- Data fetch -------------------------------------------------------
  const fetchCustomers = useCallback(async () => {
    const { data } = await supabase
      .from("customers")
      .select("id, name, phone")
      .order("name", { ascending: true });
    setCustomers((data ?? []) as Customer[]);
  }, []);

  useEffect(() => {
    void fetchCustomers();
  }, [fetchCustomers]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetchPricingCatalog({ branchId: branch.id });
      if (!cancelled) setCatalog(res.services);
    })();
    return () => {
      cancelled = true;
    };
  }, [branch.id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const techs = await fetchActiveTechnicians({ branchId: branch.id });
      if (!cancelled) setTechnicians(techs);
    })();
    return () => {
      cancelled = true;
    };
  }, [branch.id]);

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

  // ----- Item helpers -----------------------------------------------------
  const patchItem = useCallback((localId: string, patch: Partial<DraftItem>) => {
    setItems((curr) =>
      curr.map((it) => (it.localId === localId ? { ...it, ...patch } : it))
    );
  }, []);

  const addItem = () => setItems((curr) => [...curr, makeEmptyItem()]);
  const removeItem = (localId: string) =>
    setItems((curr) =>
      curr.length <= 1 ? curr : curr.filter((it) => it.localId !== localId)
    );

  // ----- Totals -----------------------------------------------------------
  const subtotal = useMemo(
    () =>
      items.reduce(
        (s, it) =>
          s +
          Math.max(1, Math.floor(Number(it.quantity) || 1)) *
            Math.max(0, Number(it.unitPrice) || 0),
        0
      ),
    [items]
  );
  const urgentTotal = useMemo(
    () =>
      items.reduce(
        (s, it) => s + (it.urgent ? Math.max(0, Number(it.urgentFee) || 0) : 0),
        0
      ),
    [items]
  );
  const discount = Math.min(
    Math.max(0, Number(discountInput) || 0),
    subtotal + urgentTotal
  );
  const grandTotal = Math.max(0, subtotal + urgentTotal - discount);

  // ----- Submit -----------------------------------------------------------
  const handleSubmit = async () => {
    setErrorMessage(null);

    // Resolve / create the customer.
    let resolved = selectedCustomer;
    if (!resolved && isCreatingNewCustomer) {
      if (!newCustomerName.trim() || !newCustomerPhone.trim()) {
        setErrorMessage("กรอกชื่อและเบอร์ลูกค้าใหม่");
        return;
      }
      const dup = customers.find(
        (c) => normalizePhone(c.phone) === normalizePhone(newCustomerPhone)
      );
      if (dup) {
        resolved = dup;
      }
    }
    if (!resolved && !isCreatingNewCustomer) {
      setErrorMessage("เลือกหรือเพิ่มลูกค้าก่อนบันทึก");
      return;
    }

    // Validate items.
    if (items.length === 0) {
      setErrorMessage("เพิ่มอย่างน้อย 1 รายการ");
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const svc = resolveService(it, catalog);
      if (!svc.name) {
        setErrorMessage(`รายการที่ ${i + 1}: เลือกบริการ หรือพิมพ์ชื่อบริการ`);
        return;
      }
      if (Math.max(0, Number(it.unitPrice) || 0) <= 0) {
        setErrorMessage(`รายการที่ ${i + 1}: กรอกราคา`);
        return;
      }
    }
    if (businessType === "care_u" && !normalizeJobId(careUJobId)) {
      setErrorMessage("กรอก Job ID ก่อนบันทึก (Care U)");
      return;
    }
    // Care U saves only once the live check has CONFIRMED the Job ID
    // is available — never while it is checking / duplicate / error /
    // idle. The message names the actual blocking state.
    if (businessType === "care_u" && jobIdCheck !== "available") {
      setErrorMessage(
        jobIdCheck === "duplicate"
          ? "Job ID นี้ถูกใช้แล้วในสาขานี้ — เปลี่ยน Job ID ก่อนบันทึก"
          : jobIdCheck === "error"
            ? JOB_ID_CHECK_ERROR_MESSAGE
            : jobIdCheck === "checking"
              ? "กำลังตรวจสอบ Job ID — รอผลตรวจก่อนบันทึก"
              : "กรอก Job ID ที่ใช้งานได้ก่อนบันทึก"
      );
      return;
    }

    // From here a network call may throw — `finally` guarantees the
    // submit lock is released so the "บันทึกใบงาน" button can never get
    // stuck disabled showing "กำลังบันทึก...".
    setIsSubmitting(true);
    try {
      // Create the customer row if needed.
      if (!resolved && isCreatingNewCustomer) {
        const { data: branchRows } = await supabase
          .from("branches")
          .select("id")
          .limit(1);
        const firstBranch = branchRows?.[0] as { id: string } | undefined;
        if (!firstBranch) {
          setErrorMessage("ยังไม่มีสาขาในระบบ");
          return;
        }
        const insert = await supabase
          .from("customers")
          .insert({
            branch_id: firstBranch.id,
            name: newCustomerName.trim(),
            phone: newCustomerPhone.trim(),
            normalized_phone: normalizePhone(newCustomerPhone),
            email: "N/A",
            address: "N/A",
            notes: null,
          })
          .select("id, name, phone")
          .single();
        if (insert.error || !insert.data) {
          setErrorMessage(insert.error?.message ?? "บันทึกลูกค้าใหม่ไม่สำเร็จ");
          return;
        }
        resolved = insert.data as Customer;
      }
      if (!resolved) {
        setErrorMessage("ไม่พบลูกค้า");
        return;
      }

      // Build the order_items payload.
      const itemInputs: OrderItemInput[] = items.map((it) => {
        const svc = resolveService(it, catalog);
        return {
          category: svc.category || null,
          serviceCode: svc.code,
          serviceName: svc.name,
          detail: it.detail.trim() || null,
          quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
          unitPrice: Math.max(0, Number(it.unitPrice) || 0),
          urgent: it.urgent,
          urgentFee: it.urgent ? Math.max(0, Number(it.urgentFee) || 0) : 0,
          dueDate: it.dueDate || null,
          assignedTechnicianId: it.technicianId || null,
          technicianNote: it.technicianNote.trim() || null,
          customerNote: it.customerNote.trim() || null,
          imagePaths: it.imagePaths,
        };
      });

      // Header summary — representative service + earliest due date.
      const first = resolveService(items[0], catalog);
      const headerName =
        items.length > 1
          ? `${first.name} +${items.length - 1} รายการ`
          : first.name;
      const dueDates = items
        .map((it) => it.dueDate)
        .filter((d): d is string => !!d)
        .sort();
      const anyUrgent = items.some((it) => it.urgent);

      const { orderId, error } = await createSmartOrder({
        customerId: resolved.id,
        customerName: resolved.name,
        customerType,
        branchId: branch.id,
        businessType,
        serviceCategory: first.category || null,
        serviceCode: first.code,
        serviceName: headerName,
        templateText:
          items.length === 1 ? items[0].detail.trim() || null : headerName,
        quantity: items.reduce(
          (s, it) => s + Math.max(1, Math.floor(Number(it.quantity) || 1)),
          0
        ),
        subtotal,
        urgent: anyUrgent,
        urgentFee: urgentTotal,
        promotionCode: discount > 0 ? "MANUAL" : null,
        discount,
        total: grandTotal,
        notes: orderNote.trim() || null,
        status: "pending",
        jobId: businessType === "care_u" ? careUJobId : null,
        createdBy: user?.uid ?? null,
        dueDate: dueDates[0] ?? null,
      });

      // A duplicate Job ID (Care U) lands here as a plain error string —
      // shown to staff, who can edit the Job ID and save again.
      if (error || !orderId) {
        setErrorMessage(error ?? "บันทึกใบงานไม่สำเร็จ");
        return;
      }

      // Child line-items. A failure here is surfaced but the header is
      // already saved — staff can re-open the order to fix items.
      const itemsRes = await insertOrderItems(orderId, branch.id, itemInputs);
      if (itemsRes.error) {
        setErrorMessage(
          `บันทึกใบงานแล้ว แต่บันทึกรายการไม่สำเร็จ: ${itemsRes.error}`
        );
        return;
      }

      // Fire-and-forget post-create hooks (sheet sync + lifecycle).
      void fetch("/api/sync-order-to-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      }).catch(() => {});
      void triggerLifecycleEvent("order_created", orderId);

      onCreated?.({
        orderId,
        itemCount: items.length,
        total: grandTotal,
        customerName: resolved.name,
      });
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "บันทึกใบงานไม่สำเร็จ — ลองอีกครั้ง"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const setBusinessType = (next: BusinessType) => {
    setBusinessTypeState(next);
    setBusinessTypeTouched(true);
  };

  // ----- Render -----------------------------------------------------------
  // Section card — no bottom margin; the columns space with `space-y`.
  const card =
    "bg-white rounded-2xl border border-gray-200 shadow-sm p-4";

  // Care U cannot save until the live check CONFIRMS the Job ID is
  // available — checking / duplicate / error / idle all block save,
  // with the reason shown next to the button. Ezy Repair auto-makes
  // its Job ID, so jobIdCheck never gates it.
  const jobIdBlocksSave =
    businessType === "care_u" && jobIdCheck !== "available";
  const blockReason = !jobIdBlocksSave
    ? null
    : jobIdCheck === "duplicate"
      ? "Job ID ซ้ำ — แก้ Job ID ก่อนจึงจะบันทึกได้"
      : jobIdCheck === "error"
        ? JOB_ID_CHECK_ERROR_MESSAGE
        : jobIdCheck === "checking"
          ? "กำลังตรวจสอบ Job ID — รอสักครู่"
          : "กรอก Job ID ที่ใช้งานได้ก่อนบันทึก";
  const saveDisabled = isSubmitting || jobIdBlocksSave;

  return (
    // Tablet-first: capture column on the left, sticky summary + save
    // on the right. 2:1 on lg, widening to 3:1 on xl so the capture
    // column uses the horizontal space. Single column on phones.
    <div className="grid gap-4 lg:grid-cols-3 xl:grid-cols-4 lg:items-start">
      {/* ---------- LEFT — capture ---------- */}
      <div className="space-y-4 lg:col-span-2 xl:col-span-3">
      {/* 1 — Branch · 2 — Job type. Two quick selectors share one row
          on tablet/desktop so the gated steps below keep the vertical
          space. Branch is step 1, job type step 2 — the workflow order
          the counter follows: branch → job type → Job ID → customer. */}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* 1 — Branch */}
        <section className={card}>
          <p className="text-xs font-bold uppercase tracking-widest text-green-700 mb-3">
            1 • สาขา
          </p>
          {canOverrideBranch ? (
            <select
              value={branch.id}
              onChange={(e) => setBranchId(e.target.value)}
              className="w-full rounded-xl border border-gray-300 bg-white p-3 text-sm outline-none focus:ring-2 focus:ring-green-500"
            >
              {ALL_BRANCHES.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.shortLabel}
                </option>
              ))}
            </select>
          ) : (
            <p className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm font-medium text-gray-700">
              {branch.shortLabel}
            </p>
          )}
        </section>

        {/* 2 — Job type / business type */}
        <section className={card}>
          <p className="text-xs font-bold uppercase tracking-widest text-green-700 mb-3">
            2 • ประเภทงาน
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setBusinessType("care_u")}
              className={`rounded-xl border px-3 py-3 text-sm font-semibold ${
                businessType === "care_u"
                  ? "bg-green-700 border-green-700 text-white"
                  : "bg-white border-gray-300 text-gray-700"
              }`}
            >
              Care U
              <span className="block text-[10px] font-normal mt-0.5 opacity-90">
                เสื้อผ้า / ดัดแปลง
              </span>
            </button>
            <button
              type="button"
              onClick={() => setBusinessType("ezy_repair")}
              className={`rounded-xl border px-3 py-3 text-sm font-semibold ${
                businessType === "ezy_repair"
                  ? "bg-yellow-500 border-yellow-500 text-white"
                  : "bg-white border-gray-300 text-gray-700"
              }`}
            >
              Ezy Repair
              <span className="block text-[10px] font-normal mt-0.5 opacity-90">
                รองเท้า / กระเป๋า
              </span>
            </button>
          </div>
        </section>
      </div>

      {/* 3 — Job ID. Manual entry for Care U; Ezy Repair auto-generates
          it server-side on save. Comes right after job type. */}
      <section className={card}>
        <p className="text-xs font-bold uppercase tracking-widest text-green-700 mb-3">
          3 • Job ID
        </p>
        {businessType === "care_u" ? (
          <input
            type="text"
            value={careUJobId}
            autoFocus
            onChange={(e) => {
              setCareUJobId(e.target.value);
              // Editing invalidates any stale duplicate error.
              if (errorMessage) setErrorMessage(null);
            }}
            placeholder="เช่น CARE-001"
            maxLength={32}
            className={`w-full rounded-xl border p-3 text-base font-mono outline-none focus:ring-2 ${
              jobIdCheck === "duplicate"
                ? "border-red-400 bg-red-50 focus:ring-red-500"
                : jobIdCheck === "available"
                  ? "border-green-500 bg-green-50/60 focus:ring-green-500"
                  : jobIdCheck === "error"
                    ? "border-amber-400 bg-amber-50 focus:ring-amber-500"
                    : "border-gray-300 focus:ring-green-500"
            }`}
          />
        ) : (
          <p className="rounded-xl border border-dashed border-green-300 bg-green-50/40 p-3 text-sm text-green-800">
            Ezy Repair: ระบบสร้าง Job ID อัตโนมัติเมื่อบันทึก
          </p>
        )}
      </section>

      {/* 4 — Live duplicate check — its own gate, BEFORE the customer
          section. Runs (debounced) as staff type, so a clash surfaces
          here and never as a blind failure at save time. The card
          rings red/green so the result reads at a glance even when the
          Job ID input is scrolled off the top of a tablet. */}
      <section
        className={`${card} ${
          businessType === "care_u" && jobIdCheck === "duplicate"
            ? "ring-2 ring-red-300"
            : businessType === "care_u" && jobIdCheck === "available"
              ? "ring-2 ring-green-300"
              : businessType === "care_u" && jobIdCheck === "error"
                ? "ring-2 ring-amber-300"
                : ""
        }`}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs font-bold uppercase tracking-widest text-green-700">
            4 • ตรวจสอบ Job ID ซ้ำ
          </p>
          {businessType === "care_u" && <JobIdBadge state={jobIdCheck} />}
        </div>
        {businessType === "care_u" ? (
          <p
            className={`text-sm font-medium ${
              jobIdCheck === "duplicate"
                ? "text-red-600"
                : jobIdCheck === "available"
                  ? "text-green-700"
                  : jobIdCheck === "error"
                    ? "text-amber-600"
                    : "text-gray-500"
            }`}
          >
            {jobIdCheck === "checking" && "กำลังตรวจสอบ Job ID…"}
            {jobIdCheck === "duplicate" &&
              `❌ Job ID "${normalizeJobId(careUJobId) ?? ""}" ถูกใช้แล้วในสาขานี้ — ลองอันใหม่`}
            {jobIdCheck === "available" &&
              `✓ Job ID "${normalizeJobId(careUJobId) ?? ""}" ใช้งานได้`}
            {jobIdCheck === "error" && `⚠ ${JOB_ID_CHECK_ERROR_MESSAGE}`}
            {jobIdCheck === "idle" &&
              "กรอก Job ID ด้านบนก่อน — ระบบตรวจซ้ำให้อัตโนมัติก่อนรับลูกค้า"}
          </p>
        ) : (
          <p className="text-sm text-gray-500">
            Ezy Repair ใช้ Job ID อัตโนมัติ — ไม่ต้องตรวจซ้ำ
          </p>
        )}
      </section>

      {/* 5 — Customer — reached only after the Job ID + duplicate-check
          gate above. */}
      <section className={card}>
        <p className="text-xs font-bold uppercase tracking-widest text-green-700 mb-3">
          5 • ลูกค้า
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
            {/* Two-up on tablet/desktop — keeps the new-customer
                form on a single row, less vertical scrolling. */}
            <div className="grid gap-3 sm:grid-cols-2">
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
            </div>
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
              placeholder="ค้นหาด้วยเบอร์โทรหรือชื่อ"
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
              <p className="mt-2 text-xs text-gray-500">ไม่พบลูกค้าที่ตรงกัน</p>
            )}
            <button
              type="button"
              onClick={() => {
                setIsCreatingNewCustomer(true);
                const digits = normalizePhone(customerSearch);
                if (digits) setNewCustomerPhone(customerSearch);
                else setNewCustomerName(customerSearch);
              }}
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

      {/* 6 — Services / items */}
      <section className={card}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-bold uppercase tracking-widest text-green-700">
            6 • รายการรับซ่อม ({items.length})
          </p>
          {/* Running total here too — on a phone the sticky summary
              is far below, so staff see the net without scrolling. */}
          <span className="text-sm font-bold text-green-700">
            {formatCurrency(grandTotal)}
          </span>
        </div>
        <div className="space-y-3">
          {items.map((it, idx) => (
            <ItemCard
              key={it.localId}
              index={idx}
              item={it}
              catalog={catalog}
              technicians={technicians}
              branchCode={branch.branchCode}
              canRemove={items.length > 1}
              lineTotal={draftLineTotal(it)}
              onPatch={(patch) => patchItem(it.localId, patch)}
              onRemove={() => removeItem(it.localId)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={addItem}
          className="mt-3 w-full border border-dashed border-green-500 text-green-700 hover:bg-green-50 font-semibold rounded-xl py-2.5"
        >
          + เพิ่มรายการ
        </button>
      </section>

      </div>

      {/* ---------- RIGHT — sticky summary + save ---------- */}
      <aside className="lg:col-span-1">
        <div className="space-y-3 lg:sticky lg:top-4">
          <section className={card}>
            <p className="text-xs font-bold uppercase tracking-widest text-green-700 mb-3">
              7 • สรุปยอด
            </p>
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm space-y-1.5">
              <div className="flex justify-between">
                <span className="text-gray-600">ยอดรวมรายการ</span>
                <span className="text-gray-800">
                  {formatCurrency(subtotal)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">คิวงานด่วน</span>
                <span className="text-gray-800">
                  {formatCurrency(urgentTotal)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-gray-600">ส่วนลด</span>
                <input
                  type="number"
                  inputMode="decimal"
                  value={discountInput}
                  onChange={(e) => setDiscountInput(e.target.value)}
                  placeholder="0"
                  className="w-28 rounded-lg border border-gray-300 p-1.5 text-right text-sm outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div className="flex justify-between items-center pt-1 border-t border-gray-200">
                <span className="text-gray-700 font-medium">ยอดรวมสุทธิ</span>
                <span className="text-2xl font-bold text-green-700">
                  {formatCurrency(grandTotal)}
                </span>
              </div>
            </div>
            <textarea
              value={orderNote}
              onChange={(e) => setOrderNote(e.target.value)}
              rows={2}
              placeholder="บันทึกภายในร้าน (ทั้งใบงาน)"
              className="mt-3 w-full rounded-xl border border-gray-300 p-3 outline-none focus:ring-2 focus:ring-green-500"
            />
          </section>

          {/* Reason shown right next to the save button — staff always
              see why a save is blocked; never a silent failure. */}
          {(blockReason || errorMessage) && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              {blockReason ?? errorMessage}
            </div>
          )}

          <button
            onClick={() => void handleSubmit()}
            disabled={saveDisabled}
            className="w-full rounded-xl bg-green-700 py-4 text-base font-bold text-white shadow-sm hover:bg-green-800 disabled:opacity-50"
          >
            {isSubmitting ? "กำลังบันทึก…" : "บันทึกใบงาน"}
          </button>
        </div>
      </aside>
    </div>
  );
}

// ---------- Item card -------------------------------------------------------

function ItemCard({
  index,
  item,
  catalog,
  technicians,
  branchCode,
  canRemove,
  lineTotal,
  onPatch,
  onRemove,
}: {
  index: number;
  item: DraftItem;
  catalog: ServiceItem[];
  technicians: TechnicianProfile[];
  branchCode: string;
  canRemove: boolean;
  lineTotal: number;
  onPatch: (patch: Partial<DraftItem>) => void;
  onRemove: () => void;
}) {
  const filtered = catalog.filter(
    (s) => !item.category || s.category === item.category
  );
  const isOther = item.serviceCode === OTHER_CODE;

  const onSelectService = (code: string) => {
    const svc = catalog.find((s) => s.code === code);
    onPatch({
      serviceCode: code,
      detail: svc?.templateTh ?? item.detail,
      unitPrice:
        svc && svc.basePrice !== null ? String(svc.basePrice) : item.unitPrice,
    });
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-gray-700">
          รายการที่ {index + 1}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-green-700">
            {formatCurrency(lineTotal)}
          </span>
          {canRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="text-xs font-semibold text-red-600 hover:text-red-700"
            >
              ลบ
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <select
          value={item.category}
          onChange={(e) =>
            onPatch({
              category: e.target.value as ServiceCategoryKey | "",
              serviceCode: "",
            })
          }
          className="rounded-lg border border-gray-300 bg-white p-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="">ทุกหมวด</option>
          {SERVICE_CATEGORIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.labelTh}
            </option>
          ))}
        </select>
        <select
          value={item.serviceCode}
          onChange={(e) => onSelectService(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white p-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="">เลือกบริการ</option>
          {filtered.map((s) => (
            <option key={s.code} value={s.code}>
              {s.nameTh}
              {s.basePrice === null ? " • ประเมินราคา" : ` • ฿${s.basePrice}`}
            </option>
          ))}
          <option value={OTHER_CODE}>อื่นๆ — ระบุบริการเอง</option>
        </select>
      </div>

      {isOther && (
        <input
          type="text"
          value={item.customName}
          onChange={(e) => onPatch({ customName: e.target.value })}
          placeholder="ชื่อบริการ (พิมพ์เอง)"
          className="mt-2 w-full rounded-lg border border-green-300 bg-green-50/40 p-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
        />
      )}

      <textarea
        value={item.detail}
        onChange={(e) => onPatch({ detail: e.target.value })}
        rows={2}
        placeholder="รายละเอียดงาน"
        className="mt-2 w-full rounded-lg border border-gray-300 p-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
      />

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <LabeledField label="ราคา/หน่วย">
          <input
            type="number"
            inputMode="decimal"
            value={item.unitPrice}
            onChange={(e) => onPatch({ unitPrice: e.target.value })}
            placeholder="0"
            className="w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
          />
        </LabeledField>
        <LabeledField label="จำนวน">
          <input
            type="number"
            inputMode="numeric"
            value={item.quantity}
            onChange={(e) => onPatch({ quantity: e.target.value })}
            className="w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
          />
        </LabeledField>
        <LabeledField label="กำหนดรับ">
          <input
            type="date"
            value={item.dueDate}
            onChange={(e) => onPatch({ dueDate: e.target.value })}
            className="w-full rounded-lg border border-gray-300 p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
          />
        </LabeledField>
        <LabeledField label="ช่าง">
          <select
            value={item.technicianId}
            onChange={(e) => onPatch({ technicianId: e.target.value })}
            className="w-full rounded-lg border border-gray-300 bg-white p-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">— ยังไม่ระบุ —</option>
            {technicians.map((t) => (
              <option key={t.id} value={t.id}>
                {t.display_name}
              </option>
            ))}
          </select>
        </LabeledField>
      </div>

      <label className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-2">
        <span className="text-sm font-medium text-gray-800">
          คิวงานด่วน +{Math.max(0, Number(item.urgentFee) || 0)}
        </span>
        <input
          type="checkbox"
          checked={item.urgent}
          onChange={(e) => onPatch({ urgent: e.target.checked })}
          className="w-5 h-5 accent-green-700"
        />
      </label>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <input
          type="text"
          value={item.customerNote}
          onChange={(e) => onPatch({ customerNote: e.target.value })}
          placeholder="หมายเหตุจากลูกค้า"
          className="w-full rounded-lg border border-gray-300 p-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
        />
        <input
          type="text"
          value={item.technicianNote}
          onChange={(e) => onPatch({ technicianNote: e.target.value })}
          placeholder="โน้ตถึงช่าง (ภายใน)"
          className="w-full rounded-lg border border-gray-300 p-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
        />
      </div>

      <div className="mt-3 rounded-lg border border-gray-200 bg-white p-2.5">
        <p className="mb-1.5 text-xs font-semibold text-gray-700">
          รูปงาน / จุดเสียหาย
        </p>
        <OrderItemImages
          value={item.imagePaths}
          onChange={(paths) => onPatch({ imagePaths: paths })}
          branchCode={branchCode}
        />
      </div>
    </div>
  );
}

// Compact Job ID status pill — mirrors the live duplicate check in
// the section header so staff get the result at a glance, before
// they ever touch the customer section.
function JobIdBadge({ state }: { state: JobIdCheckState }) {
  if (state === "idle") return null;
  const style =
    state === "duplicate"
      ? "bg-red-100 text-red-700"
      : state === "available"
        ? "bg-green-100 text-green-700"
        : state === "error"
          ? "bg-amber-100 text-amber-700"
          : "bg-gray-100 text-gray-600";
  const label =
    state === "duplicate"
      ? "✕ Job ID ซ้ำ"
      : state === "available"
        ? "✓ ใช้งานได้"
        : state === "error"
          ? "⚠ ตรวจสอบไม่สำเร็จ"
          : "กำลังตรวจสอบ…";
  return (
    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${style}`}>
      {label}
    </span>
  );
}

function LabeledField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
        {label}
      </span>
      {children}
    </label>
  );
}

export default IntakeOrderForm;
