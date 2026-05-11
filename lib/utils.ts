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

export const formatPhoneNumber = (phone: string): string => {
  // Basic Thai phone format
  if (!phone) return "";
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.length === 10) {
    return `${cleaned.substring(0, 3)}-${cleaned.substring(3, 6)}-${cleaned.substring(6)}`;
  }
  return phone;
};
