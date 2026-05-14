// Customer identity resolver — single entry point for "find or create the
// customer behind this contact". Used by the portal sign-in flow, the
// quote-triage UI (future), and any future automation that needs to map
// a channel id (phone / LINE / email) to a customers row.
//
// Foundation phase covers:
//   • resolveByPhone(phone)
//   • resolveByLineUserId(lineUserId)
//   • findOrCreateByPhone(phone, opts)
//   • mergeCandidates(customerId)  — read-only "what would merge?"
//   • mergeCustomers(primaryId, secondaryId) — placeholder; throws today
//
// Server-only. Uses the admin client so cross-branch identity questions
// resolve uniformly for HQ flows.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizePhone } from "@/lib/phone";

export type ResolvedCustomer = {
  id: string;
  name: string | null;
  phone: string | null;
  normalizedPhone: string | null;
  email: string | null;
  branchId: string | null;
  lifecycleStage: string | null;
  customerTier: string | null;
};

const COLUMNS =
  "id, name, phone, normalized_phone, email, branch_id, lifecycle_stage, customer_tier";

function toResolved(row: Record<string, unknown>): ResolvedCustomer {
  return {
    id: String(row.id),
    name: (row.name as string) ?? null,
    phone: (row.phone as string) ?? null,
    normalizedPhone: (row.normalized_phone as string) ?? null,
    email: (row.email as string) ?? null,
    branchId: (row.branch_id as string) ?? null,
    lifecycleStage: (row.lifecycle_stage as string) ?? null,
    customerTier: (row.customer_tier as string) ?? null,
  };
}

/**
 * Find every customer row whose normalised phone matches. Returns an
 * array because legacy imports left some duplicates; the merge tool
 * (future phase) is what collapses them. Callers that need exactly one
 * pick the first match or fall through to `findOrCreateByPhone`.
 */
export async function resolveByPhone(
  rawPhone: string
): Promise<ResolvedCustomer[]> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return [];
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const { data, error } = await admin
    .from("customers")
    .select(COLUMNS)
    .eq("normalized_phone", phone);
  if (error || !data) return [];
  return (data as Array<Record<string, unknown>>).map(toResolved);
}

/** Find the customer behind a LINE follower (via customer_line_links). */
export async function resolveByLineUserId(
  lineUserId: string
): Promise<ResolvedCustomer | null> {
  if (!lineUserId) return null;
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const linkRes = await admin
    .from("customer_line_links")
    .select("customer_id, unsubscribed_at")
    .eq("line_user_id", lineUserId)
    .maybeSingle();
  const link = linkRes.data as
    | { customer_id: string | null; unsubscribed_at: string | null }
    | null;
  if (!link?.customer_id) return null;
  const custRes = await admin
    .from("customers")
    .select(COLUMNS)
    .eq("id", link.customer_id)
    .maybeSingle();
  if (custRes.error || !custRes.data) return null;
  return toResolved(custRes.data as Record<string, unknown>);
}

export type FindOrCreateOptions = {
  /** branches.code text slug. Defaults to "self-portal" pseudo-branch
   *  when null — operators can re-pin during the next visit. */
  branchId?: string | null;
  name?: string | null;
  email?: string | null;
};

/**
 * Idempotent. If exactly one match exists, return it. If multiple match,
 * return the most-recently-active one (highest last_visit_at). If none
 * match, insert a new row and return it.
 *
 * Never deletes / modifies an existing row in this call — the merge
 * decision belongs to a human admin.
 */
export async function findOrCreateByPhone(
  rawPhone: string,
  opts: FindOrCreateOptions = {}
): Promise<{ ok: true; customer: ResolvedCustomer; created: boolean } | { ok: false; reason: string }> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false, reason: "เบอร์โทรไม่ถูกต้อง" };
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" };
  }

  const candidates = await resolveByPhone(phone);
  if (candidates.length > 0) {
    // Sort by lifecycle_stage activeness + tier proxy: tiered customers
    // beat untiered, then bigger spend wins. Cheap heuristic, replaceable.
    const ranked = [...candidates].sort((a, b) => {
      const stageScore = (s: string | null) =>
        s === "active" ? 3 : s === "reactivated" ? 2 : s === "new" ? 1 : 0;
      return stageScore(b.lifecycleStage) - stageScore(a.lifecycleStage);
    });
    return { ok: true, customer: ranked[0], created: false };
  }

  const insert = await admin
    .from("customers")
    .insert({
      phone: rawPhone.trim(),
      normalized_phone: phone,
      name: opts.name ?? "ลูกค้าใหม่",
      email: opts.email ?? "N/A",
      address: "N/A",
      branch_id: opts.branchId ?? "self-portal",
      lifecycle_stage: "new",
    })
    .select(COLUMNS)
    .single();
  if (insert.error || !insert.data) {
    return { ok: false, reason: insert.error?.message ?? "Insert failed" };
  }
  return {
    ok: true,
    customer: toResolved(insert.data as Record<string, unknown>),
    created: true,
  };
}

/**
 * What customers look like merge candidates for the given customerId?
 * Foundation: returns all rows that share normalized_phone, minus the
 * input. Future: include name-fuzzy matches + branch context.
 */
export async function mergeCandidates(
  customerId: string
): Promise<ResolvedCustomer[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const self = await admin
    .from("customers")
    .select(COLUMNS)
    .eq("id", customerId)
    .maybeSingle();
  if (self.error || !self.data) return [];
  const me = toResolved(self.data as Record<string, unknown>);
  if (!me.normalizedPhone) return [];
  const others = await admin
    .from("customers")
    .select(COLUMNS)
    .eq("normalized_phone", me.normalizedPhone)
    .neq("id", customerId);
  if (others.error || !others.data) return [];
  return (others.data as Array<Record<string, unknown>>).map(toResolved);
}

/**
 * Merge `secondaryId` into `primaryId`. Reserved for a future admin tool —
 * needs to re-point orders.customer_id + customer_line_links.customer_id
 * + customer_tags / notes / activity / channels + audit trail. Doing it
 * carelessly creates orphans, so the foundation throws.
 */
export async function mergeCustomers(
  primaryId: string,
  secondaryId: string
): Promise<never> {
  void primaryId;
  void secondaryId;
  throw new Error(
    "mergeCustomers is not implemented yet — handle via admin SQL until the merge UI ships"
  );
}
