// Thai and English language support
export const translations = {
  th: {
    // Navigation
    nav: {
      dashboard: "แดชบอร์ด",
      customers: "ลูกค้า",
      orders: "คำสั่งซ่อม",
      invoices: "ใบเสร็จ",
      settings: "ตั้งค่า",
    },
    
    // Dashboard
    dashboard: {
      title: "แดชบอร์ด CareU",
      welcomeMessage: "ยินดีต้อนรับสู่ระบบจัดการร้านซ่อมผ้า",
      dailySales: "ยอดขายประจำวัน",
      monthlyRevenue: "รายได้รายเดือน",
      totalOrders: "จำนวนคำสั่งซ่อม",
      totalCustomers: "จำนวนลูกค้า",
      completedToday: "เสร็จสิ้นวันนี้",
      pendingOrders: "คำสั่งซ่อมรอดำเนิน",
      averageOrderValue: "มูลค่าคำสั่งซ่อมเฉลี่ย",
    },

    // Customers
    customers: {
      title: "จัดการลูกค้า",
      addCustomer: "เพิ่มลูกค้าใหม่",
      name: "ชื่อ",
      phone: "เบอร์โทรศัพท์",
      email: "อีเมล",
      address: "ที่อยู่",
      lastOrder: "คำสั่งซ่อมล่าสุด",
      totalSpent: "จำนวนเงินที่ใช้ไป",
      noCustomers: "ไม่มีลูกค้า",
      edit: "แก้ไข",
      delete: "ลบ",
      save: "บันทึก",
      cancel: "ยกเลิก",
    },

    // Repair Orders
    orders: {
      title: "คำสั่งซ่อม",
      newOrder: "สร้างคำสั่งซ่อมใหม่",
      orderID: "เลขที่คำสั่งซ่อม",
      customerName: "ชื่อลูกค้า",
      description: "รายละเอียดการซ่อม",
      items: "รายการซ่อม",
      itemName: "ชื่อสิ่งของ",
      quantity: "จำนวน",
      price: "ราคา",
      status: "สถานะ",
      pending: "รอดำเนิน",
      inProgress: "กำลังซ่อม",
      completed: "เสร็จสิ้น",
      readyForPickup: "พร้อมรับ",
      totalPrice: "ราคารวม",
      createdDate: "วันที่สร้าง",
      completedDate: "วันที่เสร็จ",
      notes: "หมายเหตุ",
      addItem: "เพิ่มรายการ",
      removeItem: "ลบรายการ",
    },

    // Invoices
    invoices: {
      title: "ใบเสร็จ",
      newInvoice: "สร้างใบเสร็จใหม่",
      invoiceID: "เลขที่ใบเสร็จ",
      invoiceDate: "วันที่ออกใบเสร็จ",
      dueDate: "กำหนดชำระ",
      subtotal: "รวมก่อนภาษี",
      tax: "ภาษี",
      total: "รวมทั้งสิ้น",
      paymentStatus: "สถานะการชำระเงิน",
      pending: "รอชำระเงิน",
      paid: "ชำระแล้ว",
      partial: "ชำระบางส่วน",
      paidDate: "วันที่ชำระเงิน",
      markAsPaid: "ทำเครื่องหมายว่าชำระแล้ว",
      print: "พิมพ์",
      download: "ดาวน์โหลด",
    },

    // Common
    common: {
      add: "เพิ่ม",
      edit: "แก้ไข",
      delete: "ลบ",
      save: "บันทึก",
      cancel: "ยกเลิก",
      search: "ค้นหา",
      filter: "ตัวกรอง",
      export: "ส่งออก",
      import: "นำเข้า",
      actions: "การกระทำ",
      noData: "ไม่มีข้อมูล",
      loading: "กำลังโหลด...",
      error: "เกิดข้อผิดพลาด",
      success: "สำเร็จ",
      confirm: "ยืนยัน",
      close: "ปิด",
      back: "กลับ",
      date: "วันที่",
      time: "เวลา",
      baht: "บาท",
      empty: "ว่าง",
    },

    // Months and Days
    months: ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
             "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"],
    days: ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"],
  },

  en: {
    // Navigation
    nav: {
      dashboard: "Dashboard",
      customers: "Customers",
      orders: "Repair Orders",
      invoices: "Invoices",
      settings: "Settings",
    },

    // Dashboard
    dashboard: {
      title: "CareU Dashboard",
      welcomeMessage: "Welcome to your tailoring and repair shop management system",
      dailySales: "Daily Sales",
      monthlyRevenue: "Monthly Revenue",
      totalOrders: "Total Orders",
      totalCustomers: "Total Customers",
      completedToday: "Completed Today",
      pendingOrders: "Pending Orders",
      averageOrderValue: "Average Order Value",
    },

    // Customers
    customers: {
      title: "Customer Management",
      addCustomer: "Add New Customer",
      name: "Name",
      phone: "Phone",
      email: "Email",
      address: "Address",
      lastOrder: "Last Order",
      totalSpent: "Total Spent",
      noCustomers: "No customers yet",
      edit: "Edit",
      delete: "Delete",
      save: "Save",
      cancel: "Cancel",
    },

    // Repair Orders
    orders: {
      title: "Repair Orders",
      newOrder: "Create New Order",
      orderID: "Order ID",
      customerName: "Customer Name",
      description: "Repair Description",
      items: "Items",
      itemName: "Item Name",
      quantity: "Quantity",
      price: "Price",
      status: "Status",
      pending: "Pending",
      inProgress: "In Progress",
      completed: "Completed",
      readyForPickup: "Ready for Pickup",
      totalPrice: "Total Price",
      createdDate: "Created Date",
      completedDate: "Completed Date",
      notes: "Notes",
      addItem: "Add Item",
      removeItem: "Remove Item",
    },

    // Invoices
    invoices: {
      title: "Invoices",
      newInvoice: "Create New Invoice",
      invoiceID: "Invoice ID",
      invoiceDate: "Invoice Date",
      dueDate: "Due Date",
      subtotal: "Subtotal",
      tax: "Tax",
      total: "Total",
      paymentStatus: "Payment Status",
      pending: "Pending",
      paid: "Paid",
      partial: "Partial",
      paidDate: "Paid Date",
      markAsPaid: "Mark as Paid",
      print: "Print",
      download: "Download",
    },

    // Common
    common: {
      add: "Add",
      edit: "Edit",
      delete: "Delete",
      save: "Save",
      cancel: "Cancel",
      search: "Search",
      filter: "Filter",
      export: "Export",
      import: "Import",
      actions: "Actions",
      noData: "No data",
      loading: "Loading...",
      error: "Error",
      success: "Success",
      confirm: "Confirm",
      close: "Close",
      back: "Back",
      date: "Date",
      time: "Time",
      baht: "฿",
      empty: "Empty",
    },

    // Months and Days
    months: ["January", "February", "March", "April", "May", "June",
             "July", "August", "September", "October", "November", "December"],
    days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  },
};

export type Language = "th" | "en";

export const getTranslation = (key: string, language: Language = "th"): any => {
  const keys = key.split(".");
  let current: any = translations[language];
  
  for (const k of keys) {
    current = current?.[k];
  }
  
  return current || key;
};

export const t = getTranslation;
