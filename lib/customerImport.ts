import supabase from "@/lib/supabase";

export type ParsedCustomerRow = {
  name: string;
  phone: string;
  email: string;
  address: string;
};

export type ImportResult = {
  inserted: number;
  skipped: number;
  error: string | null;
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/**
 * Parse CSV text with a header row. Expected columns (case-insensitive,
 * any order): name, phone, email, address. Email/address are optional.
 * Returns rows with whitespace trimmed; missing optional values become "".
 */
export function parseCustomersCsv(text: string): ParsedCustomerRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = {
    name: headers.indexOf("name"),
    phone: headers.indexOf("phone"),
    email: headers.indexOf("email"),
    address: headers.indexOf("address"),
  };

  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return {
      name: (idx.name >= 0 ? values[idx.name] : "")?.trim() ?? "",
      phone: (idx.phone >= 0 ? values[idx.phone] : "")?.trim() ?? "",
      email: (idx.email >= 0 ? values[idx.email] : "")?.trim() ?? "",
      address: (idx.address >= 0 ? values[idx.address] : "")?.trim() ?? "",
    };
  });
}

/**
 * Insert parsed rows into public.customers. Rows missing name or phone are
 * skipped. Empty email/address are stored as "N/A" to match the rest of the app.
 */
export async function importCustomerRows(
  rows: ParsedCustomerRow[],
  branchId: string
): Promise<ImportResult> {
  const valid = rows
    .map((r) => ({
      name: r.name.trim(),
      phone: r.phone.trim(),
      email: r.email.trim() || "N/A",
      address: r.address.trim() || "N/A",
    }))
    .filter((r) => r.name && r.phone);

  const skipped = rows.length - valid.length;
  if (valid.length === 0) {
    return { inserted: 0, skipped, error: null };
  }

  const payload = valid.map((r) => ({
    ...r,
    branch_id: branchId,
    notes: null,
  }));

  const { error } = await supabase.from("customers").insert(payload);
  return {
    inserted: error ? 0 : valid.length,
    skipped,
    error: error?.message ?? null,
  };
}
