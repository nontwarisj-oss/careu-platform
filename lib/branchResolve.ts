import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BranchIdentity = {
  uuid: string;
  code: string;
  name: string;
};

export const BRANCH_NOT_FOUND_TH =
  "ไม่พบสาขาที่เลือก กรุณาเลือกสาขาใหม่อีกครั้ง";

type BranchRow = {
  id: string | null;
  code: string | null;
  short_code: string | null;
  name: string | null;
};

function rowToIdentity(row: BranchRow): BranchIdentity | null {
  if (!row.id || !row.code) return null;
  return {
    uuid: String(row.id),
    code: String(row.code),
    name: String(row.name ?? row.code),
  };
}

async function lookupBranchBy(
  admin: SupabaseClient,
  column: "id" | "code" | "short_code" | "name",
  value: string
): Promise<BranchIdentity | null> {
  const res = await admin
    .from("branches")
    .select("id, code, short_code, name")
    .eq(column, value)
    .limit(1)
    .maybeSingle();
  if (res.error || !res.data) return null;
  return rowToIdentity(res.data as BranchRow);
}

export async function resolveBranchIdentity(
  admin: SupabaseClient,
  slugOrUuid: string | null | undefined
): Promise<BranchIdentity | null> {
  const raw = (slugOrUuid ?? "").trim();
  if (!raw) return null;

  // UUID form goes straight to branches.id; eq on id with a non-UUID
  // string would surface as a Postgres "invalid input syntax for uuid"
  // error, so only attempt it when the value actually looks like one.
  if (UUID_RE.test(raw)) {
    return lookupBranchBy(admin, "id", raw);
  }

  // Try every text identifier the DB might carry: branches.code is the
  // canonical join key everywhere else; short_code matches the human
  // prefix (e.g. "B01") that some operators type into the UI; name is
  // the exact-display label, used as a last-resort manual entry path.
  for (const column of ["code", "short_code", "name"] as const) {
    const hit = await lookupBranchBy(admin, column, raw);
    if (hit) return hit;
  }

  return null;
}
