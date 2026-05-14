// Customer linker — read + write surface for the /admin/customer-line UI.
//
//   • Reads (browser anon client; RLS scopes them):
//       fetchUnmatchedLinks(filter)   — customer_line_links where
//                                       customer_id IS NULL AND ignored_at IS NULL
//       fetchLinkedLinks(filter)      — customer_line_links with customer_id set
//   • Mutations (go through gated server routes that re-check role +
//     branch ownership):
//       linkLineUserToCustomer    — admin pairs a LINE user with a customer.
//       unlinkLineUser            — admin breaks a previous pairing.
//       markLineLinkIgnored       — admin says "this LINE user isn't a real
//                                   customer; hide it from the unmatched view".
//
// All write helpers are thin client wrappers around POST routes so the UI
// stays the same module the future linker-automation worker can reuse.
//
// Server-friendly (no React imports).

import supabase from "@/lib/supabase";

// ---------- Domain types --------------------------------------------------

export type CustomerLineLinkRow = {
  id: string;
  customer_id: string | null;
  line_user_id: string;
  display_name: string | null;
  picture_url: string | null;
  notify_order_received: boolean;
  notify_order_ready: boolean;
  notify_pickup_reminder: boolean;
  notify_receipt: boolean;
  consented_at: string | null;
  unsubscribed_at: string | null;
  ignored_at: string | null;
  ignored_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CustomerLineLinkWithStats = CustomerLineLinkRow & {
  /** Customer name resolved from customers.id when customer_id is set. */
  customerName?: string | null;
  /** Number of public.line_follow_events rows seen for this line_user_id. */
  eventCount?: number;
  /** Latest follow / unfollow event_type seen for this user. */
  latestEventType?: string | null;
  latestEventAt?: string | null;
};

export type FollowEventRow = {
  id: string;
  event_type: "follow" | "unfollow" | "message" | "other";
  line_user_id: string;
  signature_verified: boolean;
  received_at: string;
  consented_at: string | null;
  linked_to_customer_id: string | null;
};

// ---------- Reads ---------------------------------------------------------

const LINK_COLUMNS = `
  id, customer_id, line_user_id, display_name, picture_url,
  notify_order_received, notify_order_ready, notify_pickup_reminder, notify_receipt,
  consented_at, unsubscribed_at, ignored_at, ignored_by, created_at, updated_at
`;

/**
 * Customer_line_links rows that an admin still needs to triage:
 * customer_id IS NULL AND ignored_at IS NULL. Includes a per-link event
 * count so the UI can highlight "this user has 3 follow events in the
 * last week" vs a one-off probe.
 */
export async function fetchUnmatchedLinks(
  options: { limit?: number } = {}
): Promise<CustomerLineLinkWithStats[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const { data, error } = await supabase
    .from("customer_line_links")
    .select(LINK_COLUMNS)
    .is("customer_id", null)
    .is("ignored_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  const rows = data as CustomerLineLinkRow[];
  return await hydrateStats(rows);
}

/**
 * Customer_line_links with a customer_id set. Used by the "Linked" tab so
 * admins can review consent state, unsubscribe activity, and unlink if a
 * pairing turns out wrong. Branch-scoped roles see only their branch's
 * links via the existing customer_line_links_branch_read policy.
 */
export async function fetchLinkedLinks(
  options: { limit?: number } = {}
): Promise<CustomerLineLinkWithStats[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const { data, error } = await supabase
    .from("customer_line_links")
    .select(LINK_COLUMNS)
    .not("customer_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  const rows = data as CustomerLineLinkRow[];
  return await hydrateStats(rows, true);
}

async function hydrateStats(
  rows: CustomerLineLinkRow[],
  includeCustomerName = false
): Promise<CustomerLineLinkWithStats[]> {
  if (rows.length === 0) return [];

  // Pull recent event counts in one query.
  const ids = rows.map((r) => r.line_user_id);
  const { data: evRows } = await supabase
    .from("line_follow_events")
    .select("line_user_id, event_type, received_at")
    .in("line_user_id", ids)
    .order("received_at", { ascending: false });

  const stats = new Map<string, { count: number; latestType: string | null; latestAt: string | null }>();
  for (const ev of (evRows ?? []) as Array<{
    line_user_id: string;
    event_type: string;
    received_at: string;
  }>) {
    const cur = stats.get(ev.line_user_id);
    if (!cur) {
      stats.set(ev.line_user_id, {
        count: 1,
        latestType: ev.event_type,
        latestAt: ev.received_at,
      });
    } else {
      cur.count += 1;
    }
  }

  let customerNameById = new Map<string, string>();
  if (includeCustomerName) {
    const customerIds = rows
      .map((r) => r.customer_id)
      .filter((id): id is string => !!id);
    if (customerIds.length > 0) {
      const { data: custs } = await supabase
        .from("customers")
        .select("id, name")
        .in("id", customerIds);
      customerNameById = new Map(
        (custs ?? []).map((c) => [(c as { id: string }).id, (c as { name: string }).name])
      );
    }
  }

  return rows.map((r) => ({
    ...r,
    eventCount: stats.get(r.line_user_id)?.count ?? 0,
    latestEventType: stats.get(r.line_user_id)?.latestType ?? null,
    latestEventAt: stats.get(r.line_user_id)?.latestAt ?? null,
    customerName: includeCustomerName
      ? customerNameById.get(r.customer_id ?? "") ?? null
      : undefined,
  }));
}

export async function fetchRecentFollowEvents(
  lineUserId: string,
  limit = 10
): Promise<FollowEventRow[]> {
  const { data, error } = await supabase
    .from("line_follow_events")
    .select(
      "id, event_type, line_user_id, signature_verified, received_at, consented_at, linked_to_customer_id"
    )
    .eq("line_user_id", lineUserId)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as FollowEventRow[];
}

// ---------- Mutations (client wrappers) -----------------------------------

export type LinkResult = { ok: true } | { ok: false; reason: string };

async function postJson<T = unknown>(
  url: string,
  body: Record<string, unknown>
): Promise<LinkResult & { data?: T }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok?: boolean; reason?: string };
    if (!res.ok || !json.ok) {
      return { ok: false, reason: json.reason ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Network error",
    };
  }
}

export async function linkLineUserToCustomer(
  linkId: string,
  customerId: string
): Promise<LinkResult> {
  return postJson("/api/admin/customer-line/link", { linkId, customerId });
}

export async function unlinkLineUser(linkId: string): Promise<LinkResult> {
  return postJson("/api/admin/customer-line/unlink", { linkId });
}

export async function markLineLinkIgnored(linkId: string): Promise<LinkResult> {
  return postJson("/api/admin/customer-line/ignore", { linkId });
}
