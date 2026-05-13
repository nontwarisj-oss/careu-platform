import supabase from "@/lib/supabase";
import { normalizePhone } from "@/lib/phone";

export type ParsedCustomerRow = {
  name: string;
  phone: string;
  email: string;
  address: string;
};

export type ImportResult = {
  /** Newly created customer rows. */
  inserted: number;
  /** Rows skipped because they were missing name or phone. */
  skipped: number;
  /** Rows whose phone already exists in the system — kept, not duplicated. */
  matchedExisting: number;
  error: string | null;
};

// Re-export so older callers keep working.
export { normalizePhone };

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
 * Insert parsed rows into public.customers. Identity is keyed on the
 * canonical Thai 10-digit phone (see lib/phone.ts), so the same person never
 * gets a second row whether the source wrote "081-234-5678", "+66 81 234
 * 5678", or "812345678".
 *
 * Behavior:
 *   - Rows missing name OR phone are reported as `skipped` and ignored.
 *   - Empty email/address default to "N/A".
 *   - Duplicate phones (against existing customers and within the same
 *     batch) are reported as `matchedExisting` and ignored — the original
 *     row is left untouched; CRM aggregations (visits, totals) are
 *     computed dynamically by joining /orders elsewhere.
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
    return { inserted: 0, skipped, matchedExisting: 0, error: null };
  }

  const { data: existing, error: fetchError } = await supabase
    .from("customers")
    .select("phone");
  if (fetchError) {
    return {
      inserted: 0,
      skipped,
      matchedExisting: 0,
      error: fetchError.message,
    };
  }

  const existingPhones = new Set(
    (existing ?? [])
      .map((r) => normalizePhone((r as { phone: string | null }).phone))
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

  const matchedExisting = valid.length - unique.length;

  if (unique.length === 0) {
    return { inserted: 0, skipped, matchedExisting, error: null };
  }

  const payload = unique.map((r) => ({
    ...r,
    branch_id: branchId,
    notes: null,
    normalized_phone: normalizePhone(r.phone),
  }));

  // Retry without normalized_phone if the migration hasn't been applied yet.
  let res = await supabase.from("customers").insert(payload);
  if (
    res.error &&
    /column .* does not exist|schema cache/i.test(res.error.message)
  ) {
    res = await supabase
      .from("customers")
      .insert(payload.map(({ normalized_phone: _drop, ...rest }) => rest));
  }

  return {
    inserted: res.error ? 0 : unique.length,
    skipped,
    matchedExisting,
    error: res.error?.message ?? null,
  };
}
