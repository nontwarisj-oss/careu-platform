"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import supabase from "@/lib/supabase";
import { useLanguage } from "@/lib/languageContext";
import { t } from "@/lib/translations";
import { Table } from "@/components/Table";
import { Modal } from "@/components/Modal";
import { CustomerHistoryModal } from "@/components/CustomerHistoryModal";
import { UnmatchedOrdersModal } from "@/components/UnmatchedOrdersModal";
import { Customer } from "@/types";
import { formatDate, formatCurrency, formatPhoneNumber } from "@/lib/utils";
import {
  parseCustomersCsv,
  importCustomerRows,
  type ParsedCustomerRow,
} from "@/lib/customerImport";
import { aggregateOrdersToCustomers } from "@/lib/customerStats";
import { normalizePhone } from "@/lib/phone";
import { useRole } from "@/lib/roleContext";
import { canManageStaff } from "@/lib/permissions";
import type { CustomerTier } from "@/lib/customerTierService";

type CustomerRow = {
  id: string;
  branch_id: string;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  notes: string | null;
  created_at: string;
  /** Tier insight columns (post-`20260531`). Nullable for un-refreshed rows. */
  customer_tier: CustomerTier | null;
  lifetime_spend: number | string | null;
  last_visit_at: string | null;
  primary_branch_id: string | null;
};

type BranchRow = {
  id: string;
};

type CustomerStats = {
  orderCount: number;
  totalSpent: number;
  latestDate: string | null;
  latestService: string | null;
};

type CustomerSegment = "vip" | "repeat" | "new";

type EnrichedCustomer = Customer & {
  orderCount: number;
  isRepeat: boolean;
  segment: CustomerSegment;
  latestService: string | null;
  /** Tier from public.customers.customer_tier (post-`20260531`). May be null
   *  if no refresh has run yet. */
  tier: CustomerTier | null;
  lifetimeSpend: number;
  lastVisitAt: string | null;
};

function classifySegment(orderCount: number): CustomerSegment {
  if (orderCount >= 5) return "vip";
  if (orderCount >= 2) return "repeat";
  return "new";
}

function tierBadgeClasses(tier: CustomerTier): string {
  switch (tier) {
    case "PREMIUM":
      return "border-purple-300 bg-purple-50 text-purple-800";
    case "VIP":
      return "border-yellow-300 bg-yellow-50 text-yellow-900";
    case "INACTIVE":
      return "border-gray-200 bg-gray-50 text-gray-500";
    case "REGULAR":
    default:
      return "border-blue-200 bg-blue-50 text-blue-800";
  }
}

const mapCustomerRow = (customer: CustomerRow): Customer => ({
  id: customer.id,
  name: customer.name,
  phone: customer.phone,
  email: customer.email ?? "",
  address: customer.address ?? "",
  createdAt: new Date(customer.created_at),
  totalSpent: 0,
});

export default function CustomersPage() {
  const { language } = useLanguage();
  const { role } = useRole();
  const canRefreshTiers = canManageStaff(role);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    phone: "",
    email: "",
    address: "",
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<ParsedCustomerRow[]>([]);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [historyCustomer, setHistoryCustomer] = useState<Customer | null>(null);
  const [resolverOpen, setResolverOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [statsByCustomer, setStatsByCustomer] = useState<
    Record<string, CustomerStats>
  >({});
  // Tier insight columns indexed by customer id; populated by fetchCustomers
  // from the public.customers row directly so we don't need to re-aggregate
  // client-side. Refresh tier rebuilds these values server-side.
  const [tierByCustomer, setTierByCustomer] = useState<
    Record<
      string,
      {
        tier: CustomerTier | null;
        lifetimeSpend: number;
        lastVisitAt: string | null;
        primaryBranchId: string | null;
      }
    >
  >({});
  const [isRefreshingTiers, setIsRefreshingTiers] = useState(false);
  const [tierMessage, setTierMessage] = useState<string | null>(null);
  const [statsMeta, setStatsMeta] = useState<{
    unmatchedOrders: number;
    totalOrders: number;
  }>({ unmatchedOrders: 0, totalOrders: 0 });
  const [statsError, setStatsError] = useState<string | null>(null);

  const fetchCustomers = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    const { data, error } = await supabase
      .from("customers")
      .select(
        "id, branch_id, name, phone, email, address, notes, created_at, customer_tier, lifetime_spend, last_visit_at, primary_branch_id"
      )
      .order("created_at", { ascending: false });

    if (error) {
      setErrorMessage(error.message);
      setCustomers([]);
      setIsLoading(false);
      return;
    }

    const rows = (data ?? []) as CustomerRow[];
    setCustomers(rows.map(mapCustomerRow));
    const tierMap: Record<
      string,
      {
        tier: CustomerTier | null;
        lifetimeSpend: number;
        lastVisitAt: string | null;
        primaryBranchId: string | null;
      }
    > = {};
    for (const r of rows) {
      tierMap[r.id] = {
        tier: (r.customer_tier ?? null) as CustomerTier | null,
        lifetimeSpend: Number(r.lifetime_spend ?? 0),
        lastVisitAt: r.last_visit_at,
        primaryBranchId: r.primary_branch_id,
      };
    }
    setTierByCustomer(tierMap);
    setIsLoading(false);
  }, []);

  const fetchCustomerStats = useCallback(
    async (currentCustomers: Customer[]) => {
      type OrderStatRow = {
        customer_id: string | null;
        customer_name: string | null;
        price: number | string | null;
        status?: string | null;
        created_at: string;
        service_name?: string | null;
        item_name?: string | null;
      };

      // Paginate — Supabase caps a single select at ~1000 rows. A busy shop
      // has far more orders than that; reading only the first page would
      // undercount visits + spend and make long-time customers look "new".
      // Try the wide projection first (service_name lives there post smart-
      // order migration); fall back to the legacy projection if missing.
      const PAGE = 1000;
      let wideColumns = true;
      const rows: OrderStatRow[] = [];
      for (let from = 0; from < 500000; from += PAGE) {
        const cols = wideColumns
          ? "customer_id, customer_name, price, status, created_at, service_name, item_name"
          : "customer_id, customer_name, price, status, created_at";
        const res = await supabase
          .from("orders")
          .select(cols)
          .order("created_at", { ascending: true })
          .range(from, from + PAGE - 1);
        if (res.error) {
          // Wide projection unsupported on an older DB — retry narrow once,
          // only while still on the first page so no rows are double-read.
          if (wideColumns && rows.length === 0) {
            wideColumns = false;
            from -= PAGE; // re-read this page with the narrow projection
            continue;
          }
          setStatsError(res.error.message);
          setStatsByCustomer({});
          setStatsMeta({ unmatchedOrders: 0, totalOrders: 0 });
          return;
        }
        const batch = (res.data ?? []) as unknown as OrderStatRow[];
        rows.push(...batch);
        if (batch.length < PAGE) break;
      }

      setStatsError(null);

      const { stats, unmatchedOrders, totalOrders } = aggregateOrdersToCustomers(
        currentCustomers.map((c) => ({
          id: c.id,
          name: c.name,
          phone: c.phone,
        })),
        rows.map((r) => ({
          customer_id: r.customer_id,
          customer_name: r.customer_name,
          price: Number(r.price ?? 0),
          // status lets the aggregator drop cancelled orders from
          // visits + spend totals.
          status: r.status ?? null,
          created_at: r.created_at,
          service_name: r.service_name ?? null,
          item_name: r.item_name ?? null,
        }))
      );
      setStatsByCustomer(stats);
      setStatsMeta({ unmatchedOrders, totalOrders });
    },
    []
  );

  useEffect(() => {
    void fetchCustomers();
  }, [fetchCustomers]);

  // Recompute order aggregation whenever the customer list changes. This way
  // sync / CSV import / manual add automatically refresh visit + spend
  // numbers without each handler needing to call fetchCustomerStats again.
  useEffect(() => {
    if (customers.length === 0) {
      setStatsByCustomer({});
      return;
    }
    void fetchCustomerStats(customers);
  }, [customers, fetchCustomerStats]);

  const handleAddCustomer = async () => {
    if (!formData.name.trim() || !formData.phone.trim()) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    const { data: branches, error: branchError } = await supabase
      .from("branches")
      .select("id")
      .limit(1);

    if (branchError) {
      setErrorMessage(branchError.message);
      setIsSubmitting(false);
      return;
    }

    const firstBranch = (branches?.[0] ?? null) as BranchRow | null;

    if (!firstBranch) {
      setErrorMessage("No branch found. Please seed at least one branch before adding customers.");
      setIsSubmitting(false);
      return;
    }

    const { error } = await supabase.from("customers").insert({
      branch_id: firstBranch.id,
      name: formData.name.trim(),
      phone: formData.phone.trim(),
      // Canonical phone — keeps search + visit/spend matching reliable.
      normalized_phone: normalizePhone(formData.phone),
      email: formData.email.trim() || "N/A",
      address: formData.address.trim() || "N/A",
      notes: null,
    });

    if (error) {
      setErrorMessage(error.message);
      setIsSubmitting(false);
      return;
    }

    setFormData({ name: "", phone: "", email: "", address: "" });
    setIsAddModalOpen(false);
    setIsSubmitting(false);
    await fetchCustomers();
  };

  const enrichedCustomers = useMemo<EnrichedCustomer[]>(() => {
    return customers.map((c) => {
      const stats = statsByCustomer[c.id];
      const tierInfo = tierByCustomer[c.id];
      const orderCount = stats?.orderCount ?? 0;
      return {
        ...c,
        totalSpent: stats?.totalSpent ?? tierInfo?.lifetimeSpend ?? 0,
        lastOrderDate: stats?.latestDate ? new Date(stats.latestDate) : undefined,
        orderCount,
        isRepeat: orderCount >= 2,
        segment: classifySegment(orderCount),
        latestService: stats?.latestService ?? null,
        tier: tierInfo?.tier ?? null,
        lifetimeSpend: tierInfo?.lifetimeSpend ?? 0,
        lastVisitAt: tierInfo?.lastVisitAt ?? null,
      };
    });
  }, [customers, statsByCustomer, tierByCustomer]);

  const filteredCustomers = useMemo<EnrichedCustomer[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return enrichedCustomers;
    return enrichedCustomers.filter((c) => {
      const fields = [c.name, c.phone, c.email ?? "", c.address ?? ""];
      return fields.some((f) => f.toLowerCase().includes(q));
    });
  }, [enrichedCustomers, searchQuery]);

  const crmSummary = useMemo(() => {
    const totalCustomers = enrichedCustomers.length;
    const newCustomers = enrichedCustomers.filter(
      (c) => c.segment === "new"
    ).length;
    const repeatCustomers = enrichedCustomers.filter(
      (c) => c.segment === "repeat"
    ).length;
    const vipCustomers = enrichedCustomers.filter(
      (c) => c.segment === "vip"
    ).length;
    const totalRevenue = enrichedCustomers.reduce(
      (s, c) => s + (c.totalSpent ?? 0),
      0
    );
    return {
      totalCustomers,
      newCustomers,
      repeatCustomers,
      vipCustomers,
      totalRevenue,
    };
  }, [enrichedCustomers]);

  const handleImportFile = async (file: File) => {
    setImportMessage(null);
    try {
      const text = await file.text();
      const rows = parseCustomersCsv(text);
      setImportPreview(rows);
      if (rows.length === 0) {
        setImportMessage(
          language === "th"
            ? "ไม่พบข้อมูลในไฟล์ CSV (ต้องมีหัวคอลัมน์ name,phone,email,address)"
            : "No data found in CSV (expected header: name,phone,email,address)"
        );
      }
    } catch (err) {
      setImportMessage(
        err instanceof Error ? err.message : "Failed to read file"
      );
      setImportPreview([]);
    }
  };

  const handleSyncFromSheet = async () => {
    setIsSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch("/api/sync-customers", { method: "POST" });
      const json = (await res.json()) as {
        ok?: boolean;
        inserted?: number;
        matchedExisting?: number;
        skipped?: number;
        totalRows?: number;
        error?: string;
      };
      if (!res.ok || json.error) {
        setSyncMessage(json.error ?? `Sync failed (HTTP ${res.status})`);
      } else {
        const added = json.inserted ?? 0;
        const matched = json.matchedExisting ?? 0;
        setSyncMessage(
          language === "th"
            ? `ซิงค์ลูกค้าเสร็จแล้ว\nเพิ่มใหม่ ${added} ราย\nอัปเดตลูกค้าเดิม ${matched} ราย`
            : `Customer sync complete\nAdded ${added} new\nKept ${matched} existing`
        );
        await fetchCustomers();
      }
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : "Sync failed");
    }
    setIsSyncing(false);
  };

  const handleRefreshTiers = async () => {
    if (!canRefreshTiers) return;
    setIsRefreshingTiers(true);
    setTierMessage(null);
    try {
      const res = await fetch("/api/admin/customer-tier/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 500 }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        customersScanned?: number;
        updated?: number;
        failed?: number;
      };
      if (!res.ok || !json.ok) {
        setTierMessage(
          language === "th"
            ? `Refresh tier ไม่สำเร็จ: ${json.reason ?? `HTTP ${res.status}`}`
            : `Tier refresh failed: ${json.reason ?? `HTTP ${res.status}`}`
        );
      } else {
        setTierMessage(
          language === "th"
            ? `Refresh tier เสร็จ — สแกน ${json.customersScanned ?? 0} ราย • อัปเดต ${json.updated ?? 0} • ผิดพลาด ${json.failed ?? 0}`
            : `Tier refresh done — scanned ${json.customersScanned ?? 0} • updated ${json.updated ?? 0} • failed ${json.failed ?? 0}`
        );
        await fetchCustomers();
      }
    } catch (err) {
      setTierMessage(err instanceof Error ? err.message : "Network error");
    }
    setIsRefreshingTiers(false);
  };

  const handleImportConfirm = async () => {
    if (importPreview.length === 0) return;
    setIsSubmitting(true);
    setImportMessage(null);

    const { data: branches, error: branchError } = await supabase
      .from("branches")
      .select("id")
      .limit(1);

    if (branchError || !branches?.[0]) {
      setImportMessage(
        branchError?.message ?? "No branch found. Please seed at least one branch first."
      );
      setIsSubmitting(false);
      return;
    }

    const result = await importCustomerRows(importPreview, (branches[0] as BranchRow).id);
    if (result.error) {
      setImportMessage(result.error);
      setIsSubmitting(false);
      return;
    }

    setImportMessage(
      language === "th"
        ? `นำเข้าเสร็จแล้ว • เพิ่มใหม่ ${result.inserted} ราย • อัปเดตลูกค้าเดิม ${result.matchedExisting} ราย`
        : `Imported • added ${result.inserted}, kept existing ${result.matchedExisting}`
    );
    setImportPreview([]);
    setIsSubmitting(false);
    await fetchCustomers();
  };

  const columns = [
    {
      key: "name",
      label: t("customers.name", language),
      width: "200px",
      render: (name: string, row: EnrichedCustomer) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-gray-900">{name}</span>
          {row.tier && (
            <span
              className={`inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tierBadgeClasses(row.tier)}`}
              title={
                language === "th"
                  ? `Tier: ${row.tier} · lifetime ${formatCurrency(row.lifetimeSpend)}`
                  : `Tier: ${row.tier} · lifetime ${formatCurrency(row.lifetimeSpend)}`
              }
            >
              {row.tier}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "phone",
      label: t("customers.phone", language),
      width: "140px",
      render: (phone: string) => formatPhoneNumber(phone),
    },
    {
      key: "email",
      label: t("customers.email", language),
      width: "180px",
      render: (email: string | undefined) =>
        email && email.trim() ? email : "N/A",
    },
    {
      key: "address",
      label: t("customers.address", language),
      width: "200px",
      render: (address: string | undefined) =>
        address && address.trim() ? address : "N/A",
    },
    {
      key: "orderCount",
      label: language === "th" ? "ครั้ง" : "Visits",
      width: "90px",
      render: (count: number) => (
        <span className="font-semibold text-gray-800">{count ?? 0}</span>
      ),
    },
    {
      key: "lastOrderDate",
      label: t("customers.lastOrder", language),
      width: "180px",
      render: (date: Date | undefined, row: EnrichedCustomer) => {
        if (!date) return <span className="text-gray-500">-</span>;
        return (
          <div>
            <p className="text-gray-800">
              {row.latestService ?? "-"}
            </p>
            <p className="text-[11px] text-gray-500">
              {formatDate(date, language)}
            </p>
          </div>
        );
      },
    },
    {
      key: "totalSpent",
      label: t("customers.totalSpent", language),
      width: "120px",
      render: (amount: number) => (
        <span className="font-semibold text-green-700">
          {formatCurrency(amount)}
        </span>
      ),
    },
    {
      key: "segment",
      label: language === "th" ? "ประเภทลูกค้า" : "Type",
      width: "140px",
      render: (segment: CustomerSegment) => {
        const map: Record<
          CustomerSegment,
          { th: string; en: string; classes: string }
        > = {
          vip: {
            th: "VIP",
            en: "VIP",
            classes:
              "bg-yellow-50 text-yellow-800 border-yellow-300",
          },
          repeat: {
            th: "ลูกค้าประจำ",
            en: "Repeat",
            classes: "bg-green-50 text-green-800 border-green-200",
          },
          new: {
            th: "ลูกค้าใหม่",
            en: "New",
            classes: "bg-gray-50 text-gray-700 border-gray-200",
          },
        };
        const tone = map[segment];
        return (
          <span
            className={`px-2.5 py-0.5 rounded-full text-xs font-medium border ${tone.classes}`}
          >
            {language === "th" ? tone.th : tone.en}
          </span>
        );
      },
    },
  ];

  return (
    <div className="flex-1 p-4 md:p-8 pt-20 md:pt-8">
      {/* Page Header */}
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-800">
            {t("customers.title", language)}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void handleSyncFromSheet()}
            disabled={isSubmitting || isSyncing}
            className="bg-green-700 hover:bg-green-800 text-white px-5 py-2 rounded-lg transition font-medium disabled:opacity-50"
          >
            {isSyncing
              ? language === "th"
                ? "กำลังซิงค์..."
                : "Syncing..."
              : language === "th"
              ? "ซิงค์จาก Google Sheet"
              : "Sync from Google Sheet"}
          </button>
          {canRefreshTiers && (
            <button
              onClick={() => void handleRefreshTiers()}
              disabled={isRefreshingTiers}
              className="border border-green-600 text-green-700 hover:bg-green-50 px-5 py-2 rounded-lg transition font-medium disabled:opacity-50"
              title={
                language === "th"
                  ? "อัปเดตเทียร์ลูกค้า + lifetime spend + last visit"
                  : "Recompute customer tier + lifetime spend + last visit"
              }
            >
              {isRefreshingTiers
                ? language === "th"
                  ? "กำลังคำนวณ tier..."
                  : "Refreshing tiers..."
                : language === "th"
                ? "Refresh tiers"
                : "Refresh tiers"}
            </button>
          )}
          <button
            onClick={() => {
              setImportPreview([]);
              setImportMessage(null);
              setIsImportModalOpen(true);
            }}
            disabled={isSubmitting}
            className="border border-green-600 text-green-700 hover:bg-green-50 px-5 py-2 rounded-lg transition font-medium disabled:opacity-50"
          >
            {language === "th" ? "นำเข้าลูกค้า (CSV)" : "Import CSV (backup)"}
          </button>
          <button
            onClick={() => setIsAddModalOpen(true)}
            disabled={isSubmitting}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition font-medium disabled:opacity-50"
          >
            + {t("customers.addCustomer", language)}
          </button>
        </div>
      </div>

      {/* CRM summary band */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">
            {language === "th" ? "ลูกค้าทั้งหมด" : "Total customers"}
          </p>
          <p className="mt-1 text-2xl font-bold text-gray-900">
            {crmSummary.totalCustomers}
          </p>
        </div>
        <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">
            {language === "th" ? "ลูกค้าใหม่" : "New"}
          </p>
          <p className="mt-1 text-2xl font-bold text-gray-900">
            {crmSummary.newCustomers}
          </p>
        </div>
        <div className="rounded-2xl border border-green-100 bg-green-50 p-4 shadow-sm">
          <p className="text-xs text-green-800">
            {language === "th" ? "ลูกค้าประจำ" : "Repeat"}
          </p>
          <p className="mt-1 text-2xl font-bold text-green-900">
            {crmSummary.repeatCustomers}
          </p>
        </div>
        <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-4 shadow-sm">
          <p className="text-xs text-yellow-800">
            {language === "th" ? "VIP (≥ 5 ครั้ง)" : "VIP (≥ 5)"}
          </p>
          <p className="mt-1 text-2xl font-bold text-yellow-900">
            {crmSummary.vipCustomers}
          </p>
        </div>
        <div className="rounded-2xl border border-green-200 bg-gradient-to-br from-green-50 to-yellow-50 p-4 shadow-sm col-span-2 lg:col-span-1">
          <p className="text-xs text-green-800">
            {language === "th" ? "ยอดใช้จ่ายรวม" : "Total spend"}
          </p>
          <p className="mt-1 text-2xl font-bold text-green-900">
            {formatCurrency(crmSummary.totalRevenue)}
          </p>
        </div>
      </div>

      {syncMessage && (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900 flex items-start justify-between gap-3">
          <span className="whitespace-pre-line leading-relaxed">{syncMessage}</span>
          <button
            type="button"
            onClick={() => setSyncMessage(null)}
            className="text-green-700 hover:text-green-900 -mt-0.5"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {tierMessage && (
        <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 flex items-start justify-between gap-3">
          <span className="whitespace-pre-line leading-relaxed">{tierMessage}</span>
          <button
            type="button"
            onClick={() => setTierMessage(null)}
            className="text-blue-700 hover:text-blue-900 -mt-0.5"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Search */}
      <div className="mb-4">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={
            language === "th"
              ? "ค้นหาด้วย ชื่อ / เบอร์ / อีเมล / ที่อยู่"
              : "Search by name, phone, email, or address"
          }
          className="w-full md:max-w-md px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
        />
        {searchQuery && (
          <p className="text-xs text-gray-500 mt-1">
            {language === "th"
              ? `พบ ${filteredCustomers.length} จาก ${customers.length} รายการ`
              : `${filteredCustomers.length} of ${customers.length} customers`}
          </p>
        )}
      </div>

      {errorMessage && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {statsError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {language === "th"
            ? `อ่านตาราง orders ไม่สำเร็จ จึงคำนวณยอดลูกค้าไม่ได้: ${statsError}`
            : `Could not read orders table to aggregate visits/spend: ${statsError}`}
        </div>
      )}

      {statsMeta.unmatchedOrders > 0 && (
        <div className="mb-4 flex flex-col gap-2 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 sm:flex-row sm:items-center sm:justify-between">
          <span>
            {language === "th"
              ? `มี ${statsMeta.unmatchedOrders} จาก ${statsMeta.totalOrders} ใบงานที่ยังจับคู่กับลูกค้าไม่ได้ — ใบงานเหล่านี้จะไม่ถูกนับใน "ครั้ง / จำนวนเงินที่ใช้ไป"`
              : `${statsMeta.unmatchedOrders} of ${statsMeta.totalOrders} orders could not be linked to a customer — excluded from visits/spend totals.`}
          </span>
          <button
            type="button"
            onClick={() => setResolverOpen(true)}
            className="shrink-0 rounded-lg bg-yellow-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-yellow-700"
          >
            {language === "th" ? "จับคู่ใบงาน" : "Resolve"}
          </button>
        </div>
      )}

      {/* Customers Table */}
      {isLoading ? (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8 text-center">
          <p className="text-gray-500">{language === "th" ? "กำลังโหลดข้อมูล..." : "Loading..."}</p>
        </div>
      ) : (
        <Table
          columns={columns}
          data={filteredCustomers}
          onHistory={(customer) => setHistoryCustomer(customer)}
          historyLabel={language === "th" ? "ดูประวัติ" : "View history"}
          onEdit={(customer) => {
            setSelectedCustomer(customer);
            setFormData({
              name: customer.name,
              phone: customer.phone,
              email: customer.email && customer.email !== "N/A" ? customer.email : "",
              address: customer.address && customer.address !== "N/A" ? customer.address : "",
            });
          }}
          onDelete={(customer) => {
            if (confirm(t("common.confirm", language))) {
              setCustomers(customers.filter((c) => c.id !== customer.id));
            }
          }}
          emptyMessage={t("customers.noCustomers", language)}
        />
      )}

      {/* Add/Edit Customer Modal */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setSelectedCustomer(null);
          setFormData({ name: "", phone: "", email: "", address: "" });
        }}
        title={selectedCustomer ? t("customers.edit", language) : t("customers.addCustomer", language)}
        onSubmit={handleAddCustomer}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("customers.name", language)}
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={language === "th" ? "กรอกชื่อ" : "Enter name"}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("customers.phone", language)}
            </label>
            <input
              type="tel"
              value={formData.phone}
              onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="081-234-5678"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("customers.email", language)}
            </label>
            <input
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="email@example.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("customers.address", language)}
            </label>
            <textarea
              value={formData.address}
              onChange={(e) => setFormData({ ...formData, address: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={3}
              placeholder={language === "th" ? "กรอกที่อยู่" : "Enter address"}
            />
          </div>
        </div>
      </Modal>

      {/* Import Customers Modal */}
      <Modal
        isOpen={isImportModalOpen}
        onClose={() => {
          setIsImportModalOpen(false);
          setImportPreview([]);
          setImportMessage(null);
        }}
        title={language === "th" ? "นำเข้าลูกค้าจากไฟล์ CSV" : "Import customers from CSV"}
        onSubmit={importPreview.length > 0 ? handleImportConfirm : undefined}
        submitLabel={language === "th" ? "นำเข้า" : "Import"}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            {language === "th"
              ? "ต้องมีหัวคอลัมน์: name, phone, email, address"
              : "Expected header row: name, phone, email, address"}
            <br />
            <span className="text-xs text-gray-500">
              {language === "th"
                ? "ชื่อและเบอร์ต้องมี — อีเมล/ที่อยู่ว่างได้ (เก็บเป็น N/A)"
                : "Name and phone are required. Empty email/address are stored as N/A."}
            </span>
          </p>

          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
            }}
            disabled={isSubmitting}
            className="block w-full text-sm text-gray-700 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
          />

          {importPreview.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
              {language === "th"
                ? `พบ ${importPreview.length} แถวในไฟล์`
                : `${importPreview.length} rows found in file`}
            </div>
          )}

          {importMessage && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
              {importMessage}
            </div>
          )}
        </div>
      </Modal>

      <CustomerHistoryModal
        isOpen={historyCustomer !== null}
        customerId={historyCustomer?.id ?? null}
        customerName={historyCustomer?.name ?? ""}
        customerPhone={historyCustomer?.phone}
        onClose={() => setHistoryCustomer(null)}
      />

      <UnmatchedOrdersModal
        isOpen={resolverOpen}
        customers={customers.map((c) => ({
          id: c.id,
          name: c.name,
          phone: c.phone,
        }))}
        onClose={() => setResolverOpen(false)}
        onResolved={() => void fetchCustomerStats(customers)}
      />
    </div>
  );
}
