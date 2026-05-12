"use client";

import { useCallback, useEffect, useState } from "react";
import supabase from "@/lib/supabase";
import { useLanguage } from "@/lib/languageContext";
import { t } from "@/lib/translations";
import { Table } from "@/components/Table";
import { Modal } from "@/components/Modal";
import { Customer } from "@/types";
import { formatDate, formatCurrency, formatPhoneNumber } from "@/lib/utils";

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
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    phone: "",
    email: "",
    address: "",
  });

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
    if (!formData.name || !formData.phone || !formData.address) {
      return;
    }

    setErrorMessage(null);

    const { data: branches, error: branchError } = await supabase
      .from("branches")
      .select("id")
      .limit(1);

    if (branchError) {
      setErrorMessage(branchError.message);
      return;
    }

    const firstBranch = (branches?.[0] ?? null) as BranchRow | null;

    if (!firstBranch) {
      setErrorMessage("No branch found. Please seed at least one branch before adding customers.");
      return;
    }

    const { error } = await supabase.from("customers").insert({
      branch_id: firstBranch.id,
      name: formData.name,
      phone: formData.phone,
      email: formData.email || null,
      address: formData.address,
      notes: null,
    });

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    setFormData({ name: "", phone: "", email: "", address: "" });
    setIsAddModalOpen(false);
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
    },
    {
      key: "address",
      label: t("customers.address", language),
      width: "200px",
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
      <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-800">
            {t("customers.title", language)}
          </h1>
        </div>
        <button
          onClick={() => setIsAddModalOpen(true)}
          className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition font-medium"
        >
          + {t("customers.addCustomer", language)}
        </button>
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
          data={customers}
          onEdit={(customer) => {
            setSelectedCustomer(customer);
            setFormData({
              name: customer.name,
              phone: customer.phone,
              email: customer.email || "",
              address: customer.address,
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
    </div>
  );
}
