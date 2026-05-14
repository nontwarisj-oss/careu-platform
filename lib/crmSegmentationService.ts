// CRM Audience Segmentation Service.
//
// Compiles a structured `SegmentDefinition` (the kind that lives in
// public.broadcast_drafts.segment JSONB) into a customer set + slice
// counts the audience estimation UI renders.
//
// Design:
//   • All filters are AND-combined. ANY filter that's set narrows
//     the audience. Filters left null/empty don't constrain.
//   • Cross-channel reachability is computed AFTER the customer set
//     is selected — we don't filter at SQL time on prefs because
//     the prefs table only has rows for customers who edited their
//     prefs (the rest use the documented defaults).
//   • Branch scope is enforced at every call site: callers pass
//     `scopedBranchCodes` derived from `requireRole + requireBranchAccess`
//     to limit the customer pool. Without that, a branch_manager
//     could estimate against another branch's customers.
//   • NO actual SEND happens here. This module computes counts +
//     samples. The broadcast send code (deferred to a later phase)
//     will be a separate module that READs this service.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// ---------- Types --------------------------------------------------------

export type SegmentDefinition = {
  /** Filter customers attached to these branch slugs. Empty = all
   *  branches visible to the caller. */
  branchSlugs?: string[];
  /** customer_tier values to include (bronze / silver / gold / platinum / vip). */
  tiers?: string[];
  /** lifecycle_stage values to include. */
  lifecycleStages?: string[];
  /** customer_type values (e.g. 'new', 'returning', 'walk_in'). */
  customerTypes?: string[];
  /** Lower bound on retention_score (inclusive). */
  retentionScoreGte?: number | null;
  /** Lower bound on lifetime_spend (Baht, inclusive). */
  totalSpendGte?: number | null;
  /** Lower bound on total_orders (inclusive). */
  totalOrdersGte?: number | null;
  /** "Has not visited in at least N days" — last_visit_at older than now-N. */
  inactiveDaysGte?: number | null;
  /** "Has visited in the last N days" — last_visit_at newer than now-N. */
  activeWithinDays?: number | null;
  /** When true, only include customers with an active LINE link. */
  requireLineLink?: boolean;
  /** When true, only include customers with a normalized_phone. */
  requirePhone?: boolean;
};

export type SegmentScope = {
  /** Branch slugs the caller is allowed to read. Empty means "all
   *  branches" (owner / hq_admin scope). */
  scopedBranchCodes: string[] | null;
};

export type CustomerSlim = {
  id: string;
  name: string | null;
  phone: string | null;
  normalized_phone: string | null;
  branch_id: string | null;
  customer_tier: string | null;
  lifecycle_stage: string | null;
  customer_type: string | null;
  retention_score: number | null;
  total_orders: number | null;
  lifetime_spend: number | null;
  last_visit_at: string | null;
};

export type PrefSlim = {
  customer_id: string;
  sms_enabled: boolean;
  line_enabled: boolean;
  email_enabled: boolean;
  promotional: boolean;
  order_status_alerts: boolean;
  pickup_reminders: boolean;
  payment_alerts: boolean;
};

export type AudienceCounts = {
  totalMatch: number;
  reachableLine: number;
  reachableSms: number;
  reachableEmail: number;
  optedOutLine: number;
  optedOutSms: number;
  optedOutEmail: number;
  distribution: {
    byBranch: Record<string, number>;
    byTier: Record<string, number>;
    byStage: Record<string, number>;
  };
  /** Sample of up to 20 customers — used by the audience preview UI
   *  to show "you'd reach: คุณ A, คุณ B, ...". Privacy-safe — only
   *  name + masked phone surfaces, not the full record. */
  sample: Array<{ id: string; name: string; phoneMasked: string }>;
};

const DEFAULT_PREFS: Omit<PrefSlim, "customer_id"> = {
  sms_enabled: true,
  line_enabled: true,
  email_enabled: false,
  promotional: false,
  order_status_alerts: true,
  pickup_reminders: true,
  payment_alerts: true,
};

// ---------- Helpers ------------------------------------------------------

function maskPhone(p: string | null | undefined): string {
  if (!p) return "—";
  const cleaned = p.replace(/[^\d]/g, "");
  if (cleaned.length < 4) return "—";
  return `...${cleaned.slice(-4)}`;
}

function nameOrFallback(name: string | null | undefined): string {
  return name && name.trim() ? name.trim() : "(ไม่มีชื่อ)";
}

// ---------- Core: customers fetch ----------------------------------------

async function fetchCustomersForSegment(
  segment: SegmentDefinition,
  scope: SegmentScope
): Promise<CustomerSlim[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  let q = admin
    .from("customers")
    .select(
      "id, name, phone, normalized_phone, branch_id, customer_tier, lifecycle_stage, customer_type, retention_score, total_orders, lifetime_spend, last_visit_at"
    );

  // Branch scope — caller's allow-list takes precedence. Within that,
  // the segment's own branchSlugs further narrows.
  const allowedBranches: string[] | null = scope.scopedBranchCodes;
  const segmentBranches = segment.branchSlugs ?? [];
  const effectiveBranches =
    allowedBranches === null
      ? segmentBranches.length > 0
        ? segmentBranches
        : null
      : segmentBranches.length > 0
        ? segmentBranches.filter((b) => allowedBranches.includes(b))
        : allowedBranches;
  if (effectiveBranches && effectiveBranches.length > 0) {
    q = q.in("branch_id", effectiveBranches);
  } else if (effectiveBranches && effectiveBranches.length === 0) {
    // Caller is branch-scoped but provided NO valid branch overlap →
    // zero matches. Short-circuit.
    return [];
  }

  if (segment.tiers && segment.tiers.length > 0) {
    q = q.in("customer_tier", segment.tiers);
  }
  if (segment.lifecycleStages && segment.lifecycleStages.length > 0) {
    q = q.in("lifecycle_stage", segment.lifecycleStages);
  }
  if (segment.customerTypes && segment.customerTypes.length > 0) {
    q = q.in("customer_type", segment.customerTypes);
  }
  if (typeof segment.retentionScoreGte === "number") {
    q = q.gte("retention_score", segment.retentionScoreGte);
  }
  if (typeof segment.totalSpendGte === "number") {
    q = q.gte("lifetime_spend", segment.totalSpendGte);
  }
  if (typeof segment.totalOrdersGte === "number") {
    q = q.gte("total_orders", segment.totalOrdersGte);
  }
  if (typeof segment.inactiveDaysGte === "number" && segment.inactiveDaysGte > 0) {
    const cutoff = new Date(
      Date.now() - segment.inactiveDaysGte * 24 * 60 * 60 * 1000
    ).toISOString();
    q = q.lte("last_visit_at", cutoff);
  }
  if (typeof segment.activeWithinDays === "number" && segment.activeWithinDays > 0) {
    const cutoff = new Date(
      Date.now() - segment.activeWithinDays * 24 * 60 * 60 * 1000
    ).toISOString();
    q = q.gte("last_visit_at", cutoff);
  }
  if (segment.requirePhone) {
    q = q.not("normalized_phone", "is", null);
  }

  // Cap the page hard so a runaway segment doesn't pull the whole
  // table into memory. The estimation UI is fine with up to 5000;
  // anything beyond that is "very wide" and the operator probably
  // needs to refine first.
  q = q.limit(5000);

  const { data, error } = await q;
  if (error || !data) {
    console.warn(
      "[segmentation] fetch failed",
      error?.message ?? "no rows"
    );
    return [];
  }
  return data as CustomerSlim[];
}

async function fetchPreferencesFor(
  customerIds: string[]
): Promise<Map<string, PrefSlim>> {
  const admin = getSupabaseAdmin();
  if (!admin || customerIds.length === 0) return new Map();
  // Supabase REST .in() is happy with up to a few thousand ids. We
  // already capped the customer fetch at 5000 above.
  const res = await admin
    .from("customer_notification_preferences")
    .select(
      "customer_id, sms_enabled, line_enabled, email_enabled, promotional, order_status_alerts, pickup_reminders, payment_alerts"
    )
    .in("customer_id", customerIds);
  const map = new Map<string, PrefSlim>();
  if (res.data) {
    (res.data as PrefSlim[]).forEach((r) => map.set(r.customer_id, r));
  }
  return map;
}

async function fetchLineLinkIds(
  customerIds: string[]
): Promise<Set<string>> {
  const admin = getSupabaseAdmin();
  if (!admin || customerIds.length === 0) return new Set();
  const res = await admin
    .from("customer_line_links")
    .select("customer_id, unsubscribed_at")
    .in("customer_id", customerIds);
  const set = new Set<string>();
  if (res.data) {
    (
      res.data as Array<{
        customer_id: string;
        unsubscribed_at: string | null;
      }>
    ).forEach((r) => {
      if (!r.unsubscribed_at) set.add(r.customer_id);
    });
  }
  return set;
}

// ---------- Public entry: estimate ---------------------------------------

/**
 * Compute audience counts + distribution + sample for a segment under
 * the given scope. Used by the audience UI and the broadcast preview
 * UI. NEVER sends anything.
 *
 * Returns null when the segment yields no matches OR when the caller's
 * scope rules out everything; the caller renders "0 reachable".
 */
export async function estimateAudience(opts: {
  segment: SegmentDefinition;
  scope: SegmentScope;
}): Promise<AudienceCounts> {
  const customers = await fetchCustomersForSegment(opts.segment, opts.scope);
  if (customers.length === 0) {
    return emptyCounts();
  }

  // Apply LINE-link requirement post-filter — easier than joining.
  const customerIds = customers.map((c) => c.id);
  const lineLinkIds = await fetchLineLinkIds(customerIds);
  let filtered = customers;
  if (opts.segment.requireLineLink) {
    filtered = customers.filter((c) => lineLinkIds.has(c.id));
  }

  // Fetch prefs for the post-filter set.
  const prefsMap = await fetchPreferencesFor(filtered.map((c) => c.id));

  const counts = emptyCounts();
  counts.totalMatch = filtered.length;

  for (const c of filtered) {
    const prefs = prefsMap.get(c.id);
    // Defaults match the DEFAULT_PREFS constant — opted-in to
    // transactional, opted-out of promotional. Drafts are *non-OTP*
    // by definition; we treat them as 'promotional' for the purpose
    // of the opt-in gate (operator who wants to push order updates
    // should use the lifecycle notifier, not broadcast).
    const smsOk = (prefs?.sms_enabled ?? DEFAULT_PREFS.sms_enabled) === true;
    const lineOk = (prefs?.line_enabled ?? DEFAULT_PREFS.line_enabled) === true;
    const emailOk =
      (prefs?.email_enabled ?? DEFAULT_PREFS.email_enabled) === true;
    const promoOk =
      (prefs?.promotional ?? DEFAULT_PREFS.promotional) === true;

    // For broadcast purposes, the customer must have BOTH the channel
    // enabled AND the promotional opt-in. The lifecycle notifier
    // handles transactional sends; broadcasts are promotional by
    // policy this phase.
    const broadcastOk = promoOk;
    const hasPhone = !!c.normalized_phone || !!c.phone;
    const hasLine = lineLinkIds.has(c.id);

    if (smsOk && broadcastOk && hasPhone) counts.reachableSms++;
    else if (hasPhone && !smsOk) counts.optedOutSms++;
    else if (hasPhone && !broadcastOk) counts.optedOutSms++;

    if (lineOk && broadcastOk && hasLine) counts.reachableLine++;
    else if (hasLine && !lineOk) counts.optedOutLine++;
    else if (hasLine && !broadcastOk) counts.optedOutLine++;

    if (emailOk && broadcastOk) counts.reachableEmail++;
    else if (!emailOk || !broadcastOk) counts.optedOutEmail++;

    const branchKey = c.branch_id ?? "(no-branch)";
    counts.distribution.byBranch[branchKey] =
      (counts.distribution.byBranch[branchKey] ?? 0) + 1;
    const tierKey = c.customer_tier ?? "(no-tier)";
    counts.distribution.byTier[tierKey] =
      (counts.distribution.byTier[tierKey] ?? 0) + 1;
    const stageKey = c.lifecycle_stage ?? "(no-stage)";
    counts.distribution.byStage[stageKey] =
      (counts.distribution.byStage[stageKey] ?? 0) + 1;
  }

  // Build sample — up to 20 customers, name + masked phone.
  counts.sample = filtered.slice(0, 20).map((c) => ({
    id: c.id,
    name: nameOrFallback(c.name),
    phoneMasked: maskPhone(c.normalized_phone ?? c.phone),
  }));

  return counts;
}

function emptyCounts(): AudienceCounts {
  return {
    totalMatch: 0,
    reachableLine: 0,
    reachableSms: 0,
    reachableEmail: 0,
    optedOutLine: 0,
    optedOutSms: 0,
    optedOutEmail: 0,
    distribution: { byBranch: {}, byTier: {}, byStage: {} },
    sample: [],
  };
}

// ---------- Cost projection ----------------------------------------------

/** Default SMS cost per segment in THB. Override via env var
 *  PROVIDER_SMS_COST_THB. Conservative default matches typical Thai
 *  aggregator pricing for outbound transactional SMS. */
const DEFAULT_SMS_COST_THB = 0.45;

export function estimateCostThb(counts: AudienceCounts): number {
  const perSms = Number(
    process.env.PROVIDER_SMS_COST_THB ?? DEFAULT_SMS_COST_THB
  );
  // LINE pushes are zero-marginal-cost in most plans; email is free.
  // Only SMS contributes to the bill.
  const cost = counts.reachableSms * (Number.isFinite(perSms) ? perSms : DEFAULT_SMS_COST_THB);
  return Math.round(cost * 100) / 100;
}

// ---------- Public: list available filter values -------------------------
//
// The audience builder UI needs to know "what tiers exist", "what
// branches exist", etc. We expose a small enum service so the UI
// doesn't hard-code values.

export const AVAILABLE_TIERS = ["bronze", "silver", "gold", "platinum", "vip"] as const;
export const AVAILABLE_LIFECYCLE_STAGES = [
  "new",
  "active",
  "reactivated",
  "at_risk",
  "dormant",
  "churned",
] as const;
export const AVAILABLE_CUSTOMER_TYPES = ["new", "returning", "walk_in"] as const;
