// Mock data for development and testing
import { Customer, RepairOrder, Invoice, DailySalesSummary, RepairItem, InvoiceItem } from "@/types";

export const mockCustomers: Customer[] = [
  {
    id: "1",
    name: "สมชาย สมจริง",
    phone: "081-234-5678",
    email: "somchai@example.com",
    address: "123 ซอย 45 กรุงเทพฯ",
    createdAt: new Date("2024-01-15"),
    lastOrderDate: new Date("2024-05-10"),
    totalSpent: 2500,
  },
  {
    id: "2",
    name: "สุนีย์ นวมสุข",
    phone: "089-876-5432",
    email: "sunee@example.com",
    address: "456 ถนน เพชรบุรี กรุงเทพฯ",
    createdAt: new Date("2024-02-20"),
    lastOrderDate: new Date("2024-05-08"),
    totalSpent: 1800,
  },
  {
    id: "3",
    name: "ดำเนิน ดำรงค์",
    phone: "087-654-3210",
    email: "damoen@example.com",
    address: "789 ซอย 8 สีลม กรุงเทพฯ",
    createdAt: new Date("2024-03-10"),
    lastOrderDate: new Date("2024-05-09"),
    totalSpent: 3200,
  },
];

export const mockRepairOrders: RepairOrder[] = [
  {
    id: "ORD001",
    customerId: "1",
    customerName: "สมชาย สมจริง",
    description: "ซ่อมกระเป๋า และแก้ซิป",
    items: [
      {
        id: "1",
        name: "ซ่อมกระเป๋า",
        description: "เย็บซ่อมรูที่ขาด",
        price: 500,
        quantity: 1,
      },
      {
        id: "2",
        name: "แก้ซิป",
        description: "เปลี่ยนซิปใหม่",
        price: 200,
        quantity: 1,
      },
    ],
    status: "completed",
    createdAt: new Date("2024-05-08"),
    completedAt: new Date("2024-05-10"),
    totalPrice: 700,
  },
  {
    id: "ORD002",
    customerId: "2",
    customerName: "สุนีย์ นวมสุข",
    description: "ซ่อมกางเกง",
    items: [
      {
        id: "1",
        name: "ปรับเอวกางเกง",
        description: "ลดขนาดเอว",
        price: 300,
        quantity: 1,
      },
    ],
    status: "ready-for-pickup",
    createdAt: new Date("2024-05-09"),
    completedAt: new Date("2024-05-10"),
    totalPrice: 300,
  },
  {
    id: "ORD003",
    customerId: "3",
    customerName: "ดำเนิน ดำรงค์",
    description: "เย็บใจไฮโล",
    items: [
      {
        id: "1",
        name: "เย็บใจไฮโล",
        description: "เย็บผ้าเสื้อใจ",
        price: 400,
        quantity: 2,
      },
    ],
    status: "in-progress",
    createdAt: new Date("2024-05-10"),
    totalPrice: 800,
  },
  {
    id: "ORD004",
    customerId: "1",
    customerName: "สมชาย สมจริง",
    description: "สั่งเย็บเสื้อใหม่",
    items: [
      {
        id: "1",
        name: "เย็บเสื้อวินเทจ",
        description: "เย็บเสื้อแบบเรียบง่าย",
        price: 1500,
        quantity: 1,
      },
    ],
    status: "pending",
    createdAt: new Date("2024-05-10"),
    totalPrice: 1500,
  },
];

export const mockInvoices: Invoice[] = [
  {
    id: "INV001",
    orderId: "ORD001",
    customerId: "1",
    customerName: "สมชาย สมจริง",
    items: [
      {
        id: "1",
        name: "ซ่อมกระเป๋า",
        quantity: 1,
        unitPrice: 500,
        amount: 500,
      },
      {
        id: "2",
        name: "แก้ซิป",
        quantity: 1,
        unitPrice: 200,
        amount: 200,
      },
    ],
    subtotal: 700,
    tax: 56,
    total: 756,
    paymentStatus: "paid",
    createdAt: new Date("2024-05-10"),
    paidDate: new Date("2024-05-10"),
  },
  {
    id: "INV002",
    orderId: "ORD002",
    customerId: "2",
    customerName: "สุนีย์ นวมสุข",
    items: [
      {
        id: "1",
        name: "ปรับเอวกางเกง",
        quantity: 1,
        unitPrice: 300,
        amount: 300,
      },
    ],
    subtotal: 300,
    tax: 24,
    total: 324,
    paymentStatus: "paid",
    createdAt: new Date("2024-05-10"),
    paidDate: new Date("2024-05-10"),
  },
];

export const mockDailySales: DailySalesSummary = {
  date: new Date(),
  totalOrders: 4,
  totalRevenue: 2156,
  completedOrders: 2,
  pendingOrders: 2,
  averageOrderValue: 539,
};
