"use client";

import { useState } from "react";
import { useLanguage } from "@/lib/languageContext";
import { t } from "@/lib/translations";
import { Table } from "@/components/Table";
import { Modal } from "@/components/Modal";
import { mockRepairOrders } from "@/lib/mockData";
import { RepairOrder, RepairItem } from "@/types";
import { formatDate, formatCurrency } from "@/lib/utils";

const statusColors = {
  pending: { badge: "bg-yellow-100 text-yellow-800", label: "รอดำเนิน" },
  "in-progress": { badge: "bg-blue-100 text-blue-800", label: "กำลังซ่อม" },
  completed: { badge: "bg-green-100 text-green-800", label: "เสร็จสิ้น" },
  "ready-for-pickup": {
    badge: "bg-purple-100 text-purple-800",
    label: "พร้อมรับ",
  },
};

const statusColorLabels = {
  th: {
    pending: "รอดำเนิน",
    "in-progress": "กำลังซ่อม",
    completed: "เสร็จสิ้น",
    "ready-for-pickup": "พร้อมรับ",
  },
  en: {
    pending: "Pending",
    "in-progress": "In Progress",
    completed: "Completed",
    "ready-for-pickup": "Ready",
  },
};

export default function OrdersPage() {
  const { language } = useLanguage();
  const [orders, setOrders] = useState<RepairOrder[]>(mockRepairOrders);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<RepairOrder | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [formData, setFormData] = useState({
    customerName: "",
    description: "",
    status: "pending" as const,
    items: [] as RepairItem[],
  });
  const [itemInput, setItemInput] = useState({
    name: "",
    description: "",
    price: 0,
    quantity: 1,
  });

  const handleAddOrder = () => {
    if (formData.customerName && formData.items.length > 0) {
      const totalPrice = formData.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const newOrder: RepairOrder = {
        id: `ORD${String(orders.length + 1).padStart(3, "0")}`,
        customerId: "1",
        customerName: formData.customerName,
        description: formData.description,
        items: formData.items,
        status: formData.status,
        createdAt: new Date(),
        totalPrice,
      };
      setOrders([...orders, newOrder]);
      setFormData({
        customerName: "",
        description: "",
        status: "pending",
        items: [],
      });
      setIsAddModalOpen(false);
    }
  };

  const handleAddItem = () => {
    if (itemInput.name && itemInput.price > 0) {
      const newItem: RepairItem = {
        id: String(formData.items.length + 1),
        ...itemInput,
      };
      setFormData({
        ...formData,
        items: [...formData.items, newItem],
      });
      setItemInput({ name: "", description: "", price: 0, quantity: 1 });
    }
  };

  const handleRemoveItem = (id: string) => {
    setFormData({
      ...formData,
      items: formData.items.filter((item) => item.id !== id),
    });
  };

  const columns = [
    {
      key: "id",
      label: t("orders.orderID", language),
      width: "100px",
    },
    {
      key: "customerName",
      label: t("orders.customerName", language),
      width: "150px",
    },
    {
      key: "description",
      label: t("orders.description", language),
      width: "200px",
    },
    {
      key: "status",
      label: t("orders.status", language),
      render: (status: string) => (
        <span className={`px-3 py-1 rounded-full text-xs font-medium ${statusColors[status as keyof typeof statusColors].badge}`}>
          {statusColorLabels[language][status as keyof typeof statusColorLabels.th]}
        </span>
      ),
      width: "120px",
    },
    {
      key: "totalPrice",
      label: t("orders.totalPrice", language),
      render: (price: number) => formatCurrency(price),
      width: "100px",
    },
    {
      key: "createdAt",
      label: t("orders.createdDate", language),
      render: (date: Date) => formatDate(date, language),
      width: "110px",
    },
  ];

  return (
    <div className="flex-1 p-4 md:p-8 pt-20 md:pt-8">
      {/* Page Header */}
      <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-800">
            {t("orders.title", language)}
          </h1>
        </div>
        <button
          onClick={() => {
            setIsAddModalOpen(true);
            setSelectedOrder(null);
          }}
          className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition font-medium"
        >
          + {t("orders.newOrder", language)}
        </button>
      </div>

      {/* Orders Table */}
      <Table
        columns={columns}
        data={orders}
        onRowClick={(order) => {
          setSelectedOrder(order);
          setIsDetailModalOpen(true);
        }}
        onEdit={(order) => {
          setSelectedOrder(order);
          setFormData({
            customerName: order.customerName,
            description: order.description,
            status: order.status,
            items: order.items,
          });
          setIsAddModalOpen(true);
        }}
        onDelete={(order) => {
          if (confirm(t("common.confirm", language))) {
            setOrders(orders.filter((o) => o.id !== order.id));
          }
        }}
        emptyMessage={language === "th" ? "ไม่มีคำสั่งซ่อม" : "No orders"}
      />

      {/* Add/Edit Order Modal */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setSelectedOrder(null);
          setFormData({
            customerName: "",
            description: "",
            status: "pending",
            items: [],
          });
        }}
        title={selectedOrder ? t("orders.description", language) : t("orders.newOrder", language)}
        onSubmit={handleAddOrder}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("orders.customerName", language)}
            </label>
            <input
              type="text"
              value={formData.customerName}
              onChange={(e) => setFormData({ ...formData, customerName: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("orders.description", language)}
            </label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={2}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("orders.status", language)}
            </label>
            <select
              value={formData.status}
              onChange={(e) => setFormData({ ...formData, status: e.target.value as any })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="pending">{statusColorLabels[language].pending}</option>
              <option value="in-progress">{statusColorLabels[language]["in-progress"]}</option>
              <option value="completed">{statusColorLabels[language].completed}</option>
              <option value="ready-for-pickup">{statusColorLabels[language]["ready-for-pickup"]}</option>
            </select>
          </div>

          {/* Items Section */}
          <div className="border-t pt-4">
            <h4 className="font-medium text-gray-700 mb-3">{t("orders.items", language)}</h4>

            {formData.items.length > 0 && (
              <div className="mb-4 space-y-2">
                {formData.items.map((item) => (
                  <div
                    key={item.id}
                    className="flex justify-between items-center p-2 bg-gray-100 rounded"
                  >
                    <div>
                      <p className="font-medium text-sm">{item.name}</p>
                      <p className="text-xs text-gray-600">
                        {item.quantity} x {formatCurrency(item.price)}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRemoveItem(item.id)}
                      className="text-red-600 hover:text-red-800 font-medium text-sm"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2 text-sm">
              <input
                type="text"
                placeholder={language === "th" ? "ชื่อสิ่งของ" : "Item name"}
                value={itemInput.name}
                onChange={(e) => setItemInput({ ...itemInput, name: e.target.value })}
                className="w-full px-2 py-1 border border-gray-300 rounded"
              />
              <input
                type="number"
                placeholder={t("orders.price", language)}
                value={itemInput.price}
                onChange={(e) => setItemInput({ ...itemInput, price: parseFloat(e.target.value) })}
                className="w-full px-2 py-1 border border-gray-300 rounded"
              />
              <input
                type="number"
                placeholder={t("orders.quantity", language)}
                value={itemInput.quantity}
                onChange={(e) => setItemInput({ ...itemInput, quantity: parseInt(e.target.value) })}
                className="w-full px-2 py-1 border border-gray-300 rounded"
              />
              <button
                onClick={handleAddItem}
                className="w-full bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 transition text-sm"
              >
                {t("orders.addItem", language)}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Order Detail Modal */}
      {selectedOrder && (
        <Modal
          isOpen={isDetailModalOpen}
          onClose={() => setIsDetailModalOpen(false)}
          title={`${t("orders.orderID", language)}: ${selectedOrder.id}`}
        >
          <div className="space-y-4">
            <div>
              <p className="text-sm text-gray-600">{t("orders.customerName", language)}</p>
              <p className="font-medium text-gray-800">{selectedOrder.customerName}</p>
            </div>

            <div>
              <p className="text-sm text-gray-600">{t("orders.description", language)}</p>
              <p className="font-medium text-gray-800">{selectedOrder.description}</p>
            </div>

            <div>
              <p className="text-sm text-gray-600">{t("orders.status", language)}</p>
              <span
                className={`inline-block px-3 py-1 rounded-full text-xs font-medium ${
                  statusColors[selectedOrder.status as keyof typeof statusColors].badge
                }`}
              >
                {statusColorLabels[language][selectedOrder.status as keyof typeof statusColorLabels.th]}
              </span>
            </div>

            <div>
              <p className="text-sm text-gray-600 mb-2">{t("orders.items", language)}</p>
              <div className="space-y-2">
                {selectedOrder.items.map((item) => (
                  <div key={item.id} className="flex justify-between text-sm p-2 bg-gray-100 rounded">
                    <div>
                      <p className="font-medium">{item.name}</p>
                      <p className="text-gray-600">{item.quantity} x {formatCurrency(item.price)}</p>
                    </div>
                    <p className="font-medium">{formatCurrency(item.price * item.quantity)}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="border-t pt-4 flex justify-between font-bold text-lg">
              <span>{t("orders.totalPrice", language)}</span>
              <span>{formatCurrency(selectedOrder.totalPrice)}</span>
            </div>

            <div className="text-sm text-gray-600">
              {t("orders.createdDate", language)}: {formatDate(selectedOrder.createdAt, language)}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
