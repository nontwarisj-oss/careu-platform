"use client";

import { useState } from "react";
import { useLanguage } from "@/lib/languageContext";
import { t } from "@/lib/translations";
import { Table } from "@/components/Table";
import { Modal } from "@/components/Modal";
import { mockInvoices } from "@/lib/mockData";
import { Invoice, InvoiceItem } from "@/types";
import { formatDate, formatCurrency } from "@/lib/utils";

const paymentStatusColors = {
  pending: "bg-yellow-100 text-yellow-800",
  paid: "bg-green-100 text-green-800",
  partial: "bg-orange-100 text-orange-800",
};

const paymentStatusLabels = {
  th: {
    pending: "รอชำระเงิน",
    paid: "ชำระแล้ว",
    partial: "ชำระบางส่วน",
  },
  en: {
    pending: "Pending",
    paid: "Paid",
    partial: "Partial",
  },
};

export default function InvoicesPage() {
  const { language } = useLanguage();
  const [invoices, setInvoices] = useState<Invoice[]>(mockInvoices);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);

  const handleMarkAsPaid = (invoice: Invoice) => {
    setInvoices(
      invoices.map((inv) =>
        inv.id === invoice.id
          ? { ...inv, paymentStatus: "paid" as const, paidDate: new Date() }
          : inv
      )
    );
    if (selectedInvoice?.id === invoice.id) {
      setSelectedInvoice({
        ...selectedInvoice,
        paymentStatus: "paid",
        paidDate: new Date(),
      });
    }
  };

  const columns = [
    {
      key: "id",
      label: t("invoices.invoiceID", language),
      width: "100px",
    },
    {
      key: "customerName",
      label: language === "th" ? "ชื่อลูกค้า" : "Customer",
      width: "150px",
    },
    {
      key: "total",
      label: t("invoices.total", language),
      render: (total: number) => formatCurrency(total),
      width: "100px",
    },
    {
      key: "paymentStatus",
      label: t("invoices.paymentStatus", language),
      render: (status: string) => (
        <span
          className={`px-3 py-1 rounded-full text-xs font-medium ${paymentStatusColors[status as keyof typeof paymentStatusColors]}`}
        >
          {paymentStatusLabels[language][status as keyof typeof paymentStatusLabels.th]}
        </span>
      ),
      width: "120px",
    },
    {
      key: "createdAt",
      label: t("invoices.invoiceDate", language),
      render: (date: Date) => formatDate(date, language),
      width: "110px",
    },
  ];

  return (
    <div className="flex-1 p-4 md:p-8 pt-20 md:pt-8">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-3xl md:text-4xl font-bold text-gray-800">
          {t("invoices.title", language)}
        </h1>
      </div>

      {/* Invoices Table */}
      <Table
        columns={columns}
        data={invoices}
        onRowClick={(invoice) => {
          setSelectedInvoice(invoice);
          setIsDetailModalOpen(true);
        }}
        onDelete={(invoice) => {
          if (confirm(t("common.confirm", language))) {
            setInvoices(invoices.filter((inv) => inv.id !== invoice.id));
          }
        }}
        emptyMessage={language === "th" ? "ไม่มีใบเสร็จ" : "No invoices"}
      />

      {/* Invoice Detail Modal */}
      {selectedInvoice && (
        <Modal
          isOpen={isDetailModalOpen}
          onClose={() => setIsDetailModalOpen(false)}
          title={`${t("invoices.invoiceID", language)}: ${selectedInvoice.id}`}
        >
          <div className="space-y-4 max-h-96 overflow-y-auto">
            {/* Header Info */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-600">{t("invoices.invoiceDate", language)}</p>
                <p className="font-medium">{formatDate(selectedInvoice.createdAt, language)}</p>
              </div>
              <div>
                <p className="text-gray-600">{t("invoices.dueDate", language)}</p>
                <p className="font-medium">
                  {selectedInvoice.dueDate ? formatDate(selectedInvoice.dueDate, language) : "-"}
                </p>
              </div>
            </div>

            <div className="border-t pt-4">
              <p className="text-sm text-gray-600">{t("invoices.invoiceID", language)}</p>
              <p className="font-bold text-gray-800">{selectedInvoice.customerName}</p>
            </div>

            {/* Items */}
            <div className="border-t pt-4">
              <h4 className="font-bold text-gray-800 mb-3">{t("orders.items", language)}</h4>
              <div className="space-y-2">
                {selectedInvoice.items.map((item) => (
                  <div
                    key={item.id}
                    className="flex justify-between text-sm p-2 bg-gray-50 rounded"
                  >
                    <div>
                      <p className="font-medium">{item.name}</p>
                      <p className="text-gray-600">
                        {item.quantity} x {formatCurrency(item.unitPrice)}
                      </p>
                    </div>
                    <p className="font-medium">{formatCurrency(item.amount)}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Totals */}
            <div className="border-t pt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">{t("invoices.subtotal", language)}</span>
                <span className="font-medium">{formatCurrency(selectedInvoice.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">{t("invoices.tax", language)}</span>
                <span className="font-medium">{formatCurrency(selectedInvoice.tax)}</span>
              </div>
              <div className="border-t pt-2 flex justify-between font-bold text-base">
                <span>{t("invoices.total", language)}</span>
                <span>{formatCurrency(selectedInvoice.total)}</span>
              </div>
            </div>

            {/* Payment Status */}
            <div className="border-t pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">{t("invoices.paymentStatus", language)}</p>
                  <span
                    className={`inline-block px-3 py-1 rounded-full text-xs font-medium ${
                      paymentStatusColors[
                        selectedInvoice.paymentStatus as keyof typeof paymentStatusColors
                      ]
                    }`}
                  >
                    {
                      paymentStatusLabels[language][
                        selectedInvoice.paymentStatus as keyof typeof paymentStatusLabels.th
                      ]
                    }
                  </span>
                </div>
                {selectedInvoice.paymentStatus !== "paid" && (
                  <button
                    onClick={() => handleMarkAsPaid(selectedInvoice)}
                    className="text-blue-600 hover:text-blue-800 font-medium text-sm underline"
                  >
                    {t("invoices.markAsPaid", language)}
                  </button>
                )}
              </div>

              {selectedInvoice.paidDate && (
                <p className="text-xs text-gray-600 mt-2">
                  {t("invoices.paidDate", language)}: {formatDate(selectedInvoice.paidDate, language)}
                </p>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
