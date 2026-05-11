// Customer Types
export interface Customer {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address: string;
  createdAt: Date;
  lastOrderDate?: Date;
  totalSpent: number;
}

// Repair Order Types
export interface RepairOrder {
  id: string;
  customerId: string;
  customerName: string;
  description: string;
  items: RepairItem[];
  status: "pending" | "in-progress" | "completed" | "ready-for-pickup";
  createdAt: Date;
  completedAt?: Date;
  totalPrice: number;
  notes?: string;
}

export interface RepairItem {
  id: string;
  name: string;
  description: string;
  price: number;
  quantity: number;
}

// Invoice Types
export interface Invoice {
  id: string;
  orderId: string;
  customerId: string;
  customerName: string;
  items: InvoiceItem[];
  subtotal: number;
  tax: number;
  total: number;
  paymentStatus: "pending" | "paid" | "partial";
  createdAt: Date;
  dueDate?: Date;
  paidDate?: Date;
  notes?: string;
}

export interface InvoiceItem {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

// Sales Summary Types
export interface DailySalesSummary {
  date: Date;
  totalOrders: number;
  totalRevenue: number;
  completedOrders: number;
  pendingOrders: number;
  averageOrderValue: number;
}

export interface SalesMetrics {
  dailyRevenue: number;
  dailyOrders: number;
  weeklyRevenue: number;
  monthlyRevenue: number;
  totalCustomers: number;
}
