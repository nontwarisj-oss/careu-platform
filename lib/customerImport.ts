import supabase from "@/lib/supabase";

export type ParsedCustomerRow = {
  name: string;
  phone: string;
  email: string;
  address: string;
};

export type ImportResult = {
  inserted: number;
  skipped: number;     // rows missing name or phone
  duplicates: number;  // rows skipped because phone already exists
  error: string | null;
};

export function normalizePhone(value: string): string {
  return (value ?? "").replace(/\D/g, "");
}

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
 * Insert parsed rows into public.customers. Behavior:
 *   - Rows missing name OR phone are skipped (counted in `skipped`).
 *   - Empty email/address default to "N/A".
 *   - Duplicate phones (against existing customers and within the same
 *     batch) are skipped (counted in `duplicates`). Phone is normalized
 *     to digits-only for comparison.
 *   - Surviving rows are inserted with the provided branch_id.
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
    return { inserted: 0, skipped, duplicates: 0, error: null };
  }

  const { data: existing, error: fetchError } = await supabase
    .from("customers")
    .select("phone");
  if (fetchError) {
    return { inserted: 0, skipped, duplicates: 0, error: fetchError.message };
  }

  const existingPhones = new Set(
    (existing ?? [])
      .map((r) => normalizePhone((r as { phone: string | null }).phone ?? ""))
      .filter((p) => p.length > 0)
  );

  const seen = new Set<string>();
  const unique = valid.filter((r) => {
    const key = normalizePhone(r.phone);
    if (!key) return false;
    if (existingPhones.has(key)) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const duplicates = valid.length - unique.length;

  if (unique.length === 0) {
    return { inserted: 0, skipped, duplicates, error: null };
  }

  const payload = unique.map((r) => ({
    ...r,
    branch_id: branchId,
    notes: null,
  }));

  const { error } = await supabase.from("customers").insert(payload);
  return {
    inserted: error ? 0 : unique.length,
    skipped,
    duplicates,
    error: error?.message ?? null,
  };
}
