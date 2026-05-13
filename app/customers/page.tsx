"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import supabase from "@/lib/supabase";
import { useLanguage } from "@/lib/languageContext";
import { t } from "@/lib/translations";
import { Table } from "@/components/Table";
import { Modal } from "@/components/Modal";
import { CustomerHistoryModal } from "@/components/CustomerHistoryModal";
import { Customer } from "@/types";
import { formatDate, formatCurrency, formatPhoneNumber } from "@/lib/utils";
import {
  parseCustomersCsv,
  importCustomerRows,
  type ParsedCustomerRow,
} from "@/lib/customerImport";

type CustomerRow = {
  id: string;
  branch_id: string;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  notes: string | null;
  created_at: string;
};

type BranchRow = {
  id: string;
};

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
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const fetchCustomers = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    const { data, error } = await supabase
      .from("customers")
      .select("id, branch_id, name, phone, email, address, notes, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      setErrorMessage(error.message);
      setCustomers([]);
      setIsLoading(false);
      return;
    }

    setCustomers(((data ?? []) as CustomerRow[]).map(mapCustomerRow));
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void fetchCustomers();
  }, [fetchCustomers]);

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

  const filteredCustomers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) => {
      const fields = [c.name, c.phone, c.email ?? "", c.address ?? ""];
      return fields.some((f) => f.toLowerCase().includes(q));
    });
  }, [customers, searchQuery]);

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
        duplicates?: number;
        skipped?: number;
        totalRows?: number;
        error?: string;
      };
      if (!res.ok || json.error) {
        setSyncMessage(json.error ?? `Sync failed (HTTP ${res.status})`);
      } else {
        setSyncMessage(
          language === "th"
            ? `ซิงค์สำเร็จ • เพิ่ม ${json.inserted ?? 0} • ซ้ำ ${json.duplicates ?? 0} • ข้าม ${json.skipped ?? 0}`
            : `Synced • added ${json.inserted ?? 0}, duplicates ${json.duplicates ?? 0}, skipped ${json.skipped ?? 0}`
        );
        await fetchCustomers();
      }
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : "Sync failed");
    }
    setIsSyncing(false);
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
        ? `นำเข้าสำเร็จ ${result.inserted} ราย • ซ้ำ ${result.duplicates} • ข้าม ${result.skipped}`
        : `Imported ${result.inserted}, duplicates ${result.duplicates}, skipped ${result.skipped}`
    );
    setImportPreview([]);
    setIsSubmitting(false);
    await fetchCustomers();
  };

  const columns = [
    {
      key: "name",
      label: t("customers.name", language),
      width: "180px",
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
      key: "lastOrderDate",
      label: t("customers.lastOrder", language),
      width: "120px",
      render: (date: Date | undefined) => (date ? formatDate(date, language) : "-"),
    },
    {
      key: "totalSpent",
      label: t("customers.totalSpent", language),
      width: "120px",
      render: (amount: number) => formatCurrency(amount),
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

      {syncMessage && (
        <div className="mb-4 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900 flex items-start justify-between gap-3">
          <span>{syncMessage}</span>
          <button
            type="button"
            onClick={() => setSyncMessage(null)}
            className="text-yellow-800 hover:text-yellow-900"
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
    </div>
  );
}
