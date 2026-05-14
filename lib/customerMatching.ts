// Pure customer-matching helpers. The customer linker UI uses these to
// suggest likely matches for unmapped LINE users; future CRM automation
// (NEXT phase) can reuse the same primitives without coupling to the
// linker's UI.
//
// Design rules:
//   • Pure-ish — every helper takes an explicit Supabase client (the
//     browser anon singleton in /admin/customer-line, the admin client
//     in server routes / reconcile). That keeps RLS scoping honest:
//     branch_manager calls get RLS-scoped results automatically; admin
//     route calls go through service-role.
//   • Cheap by default — exact-phone lookup is one indexed query;
//     normalized-name search is one trigram query (pg_trgm GIN index
//     from `20260526`). The "suggestLikelyCustomerMatches" combiner
//     deduplicates by id so the UI only ever sees one row per candidate.
//   • No mutation — matching helpers never write. The linker service
//     (lib/customerLinker.ts) is where writes happen.

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";

export type CustomerCandidate = {
  id: string;
  branch_id: string | null;
  name: string;
  phone: string | null;
  normalized_phone: string | null;
  email: string | null;
  /** Optional: latest order created_at (only populated by the order-history helper). */
  latestOrderAt?: string | null;
  /** Human-readable explanation for why this candidate surfaced. */
  matchReason: string;
  /** 0–100 — higher is more likely. Lets the UI sort suggestions. */
  score: number;
};

const CUSTOMER_COLUMNS =
  "id, branch_id, name, phone, normalized_phone, email";

// ---------- Single-dimension lookups --------------------------------------

/**
 * Exact match on normalized phone. Returns at most one candidate; multiple
 * customers with the same phone is a data-integrity bug (handled by the
 * reconcile layer, not here). When `branchCode` is set, restrict to that
 * branch — useful for branch_manager flows where cross-branch suggestions
 * would leak through service-role calls.
 */
export async function findCustomerByPhone(
  client: SupabaseClient,
  phone: string,
  branchCode?: string | null
): Promise<CustomerCandidate | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  let q = client
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .eq("normalized_phone", normalized)
    .limit(1);
  if (branchCode) q = q.eq("branch_id", branchCode);
  const { data, error } = await q.maybeSingle();
  if (error || !data) return null;
  const row = data as Omit<CustomerCandidate, "matchReason" | "score">;
  return {
    ...row,
    matchReason: `phone match (${normalized})`,
    score: 95,
  };
}

/**
 * Trigram-ranked name search. Uses ilike for portability and the existing
 * pg_trgm GIN index on `customers.name` from migration `20260526` makes it
 * fast at our volume. Returns up to `limit` candidates.
 */
export async function findCustomersByNormalizedName(
  client: SupabaseClient,
  name: string,
  options: { branchCode?: string | null; limit?: number } = {}
): Promise<CustomerCandidate[]> {
  const trimmed = name.trim();
  if (trimmed.length < 2) return [];
  const limit = Math.min(options.limit ?? 5, 20);
  let q = client
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .ilike("name", `%${trimmed}%`)
    .order("name")
    .limit(limit);
  if (options.branchCode) q = q.eq("branch_id", options.branchCode);
  const { data, error } = await q;
  if (error || !data) return [];
  const rows = data as Array<Omit<CustomerCandidate, "matchReason" | "score">>;
  // Score by how close the input is to the full name. Exact (lower) match
  // wins; substring match gets a partial bump.
  const lower = trimmed.toLowerCase();
  return rows.map((r) => {
    const rowLower = r.name.toLowerCase();
    let score = 40;
    if (rowLower === lower) score = 75;
    else if (rowLower.startsWith(lower)) score = 60;
    else if (rowLower.includes(lower)) score = 50;
    return {
      ...r,
      matchReason: `name match "${trimmed}"`,
      score,
    };
  });
}

/**
 * Find customers whose most recent order is within the last `days`. Useful
 * for "the LINE follow probably belongs to a customer we just served"
 * intuition — pairs nicely with the name search.
 */
export async function findRecentlyActiveCustomers(
  client: SupabaseClient,
  options: { branchCode?: string | null; days?: number; limit?: number } = {}
): Promise<CustomerCandidate[]> {
  const days = options.days ?? 7;
  const limit = Math.min(options.limit ?? 10, 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let q = client
    .from("orders")
    .select("customer_id, customer_name, branch_id, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(100);
  if (options.branchCode) q = q.eq("branch_id", options.branchCode);
  const { data, error } = await q;
  if (error || !data) return [];

  // Deduplicate by customer_id; keep the most recent order_at per customer.
  const seen = new Map<string, { lastAt: string; name: string; branchId: string | null }>();
  for (const order of data as Array<{
    customer_id: string | null;
    customer_name: string | null;
    branch_id: string | null;
    created_at: string;
  }>) {
    if (!order.customer_id) continue;
    const existing = seen.get(order.customer_id);
    if (!existing || order.created_at > existing.lastAt) {
      seen.set(order.customer_id, {
        lastAt: order.created_at,
        name: order.customer_name ?? "(no name)",
        branchId: order.branch_id ?? null,
      });
    }
  }
  if (seen.size === 0) return [];

  // Hydrate from customers table so the candidate shape carries phone +
  // normalized_phone (which the linker UI shows next to the suggestion).
  const ids = Array.from(seen.keys()).slice(0, limit);
  const { data: hydrated, error: hydrateError } = await client
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .in("id", ids);
  if (hydrateError || !hydrated) return [];
  return (hydrated as Array<Omit<CustomerCandidate, "matchReason" | "score">>).map(
    (c) => ({
      ...c,
      latestOrderAt: seen.get(c.id)?.lastAt ?? null,
      matchReason: `ordered within ${days} days`,
      score: 30,
    })
  );
}

// ---------- Combiner ------------------------------------------------------

export type SuggestMatchesInput = {
  client: SupabaseClient;
  /** LINE-side hint: display_name captured from the follow event. */
  displayName?: string | null;
  /** When the admin already typed a phone into the search box. */
  phoneHint?: string | null;
  /** Optional branch slug to scope suggestions. */
  branchCode?: string | null;
  /** Max candidates returned across all dimensions, deduped. */
  limit?: number;
};

/**
 * Combined suggestion list. Runs the three sub-searches in parallel,
 * deduplicates by `customers.id`, keeps the highest score per id, and
 * returns sorted by score descending.
 *
 * The score is heuristic — phone exact > name exact > name partial >
 * recent activity. The linker UI shows the score + reason so the admin
 * can decide; the matcher never auto-links.
 */
export async function suggestLikelyCustomerMatches(
  input: SuggestMatchesInput
): Promise<CustomerCandidate[]> {
  const limit = Math.min(input.limit ?? 10, 25);

  const work: Promise<CustomerCandidate[] | CustomerCandidate | null>[] = [];

  if (input.phoneHint && input.phoneHint.trim().length > 0) {
    work.push(
      findCustomerByPhone(input.client, input.phoneHint, input.branchCode)
    );
  }
  if (input.displayName && input.displayName.trim().length > 0) {
    work.push(
      findCustomersByNormalizedName(input.client, input.displayName, {
        branchCode: input.branchCode,
        limit: 5,
      })
    );
  }
  // Always include a small "recently active" cohort — useful when the
  // display name is something cryptic (a nickname) and the admin has no
  // phone yet.
  work.push(
    findRecentlyActiveCustomers(input.client, {
      branchCode: input.branchCode,
      days: 7,
      limit: 5,
    })
  );

  const results = await Promise.all(work);
  const byId = new Map<string, CustomerCandidate>();
  for (const r of results) {
    if (!r) continue;
    const arr = Array.isArray(r) ? r : [r];
    for (const cand of arr) {
      const existing = byId.get(cand.id);
      if (!existing || cand.score > existing.score) {
        byId.set(cand.id, cand);
      } else {
        // Surface multiple reasons so the admin sees why a candidate is
        // here even when a later signal had a lower score.
        existing.matchReason = `${existing.matchReason} + ${cand.matchReason}`;
      }
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
