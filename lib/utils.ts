export const formatDate = (date: Date | string, language: "th" | "en" = "th"): string => {
  const d = typeof date === "string" ? new Date(date) : date;
  
  if (language === "th") {
    const buddhistYear = d.getFullYear() + 543;
    return `${d.getDate()}/${d.getMonth() + 1}/${buddhistYear}`;
  }
  
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

export const formatCurrency = (amount: number): string => {
  return `฿${amount.toLocaleString("th-TH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
};

import { normalizePhone } from "@/lib/phone";

export const formatPhoneNumber = (phone: string): string => {
  // Basic Thai phone format. Normalize FIRST so a number that lost its
  // leading zero in a spreadsheet import ("812345678") still displays
  // correctly as "081-234-5678" instead of the broken 9-digit form.
  if (!phone) return "";
  const normalized = normalizePhone(phone);
  if (/^0\d{9}$/.test(normalized)) {
    return `${normalized.slice(0, 3)}-${normalized.slice(3, 6)}-${normalized.slice(6)}`;
  }
  return normalized || phone;
};
