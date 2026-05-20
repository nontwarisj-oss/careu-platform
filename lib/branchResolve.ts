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

export async function resolveBranchIdentity(
  admin: SupabaseClient,
  slugOrUuid: string | null | undefined
): Promise<BranchIdentity | null> {
  const raw = (slugOrUuid ?? "").trim();
  if (!raw) return null;

  const looksLikeUuid = UUID_RE.test(raw);

  const res = await admin
    .from("branches")
    .select("id, code, name")
    .eq(looksLikeUuid ? "id" : "code", raw)
    .maybeSingle();

  if (res.error || !res.data) return null;

  const row = res.data as {
    id: string | null;
    code: string | null;
    name: string | null;
  };

  if (!row.id || !row.code) return null;

  return {
    uuid: String(row.id),
    code: String(row.code),
    name: String(row.name ?? row.code),
  };
}
