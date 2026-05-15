// Escalation Recipients — the role-tiered contact list the alert
// escalation chain routes to.
//
// Phase 23's alert_preferences.recipients[] is a flat list. Phase 25
// adds escalation_recipients: each row is one contact pinned to a
// role tier (owner / hq_admin / branch_manager / technician_lead),
// optionally branch-scoped, with its own severity floor and a
// temporary-mute window.
//
// The escalation chain widens the audience per tier:
//   tier 'alert' → branch_manager + technician_lead
//   tier 'hq'    → + hq_admin
//   tier 'owner' → + owner
//
// Branch-aware: a recipient row with branch_id=X is included only for
// alerts on branch X; branch_id=NULL rows apply to every branch
// (the natural fallback). When no escalation_recipients resolve at
// all, the caller falls back to alert_preferences.recipients[].
//
// Cached 60s. Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const CACHE_TTL_MS = 60 * 1000;

export type RoleTier =
  | "owner"
  | "hq_admin"
  | "branch_manager"
  | "technician_lead";

export type EscalationTierName = "alert" | "hq" | "owner";

/** Which role tiers receive an alert at each escalation tier
 *  (cumulative — higher tiers include the lower ones). */
const TIER_ROLES: Record<EscalationTierName, RoleTier[]> = {
  alert: ["branch_manager", "technician_lead"],
  hq: ["branch_manager", "technician_lead", "hq_admin"],
  owner: ["branch_manager", "technician_lead", "hq_admin", "owner"],
};

type RecipientRow = {
  role_tier: RoleTier;
  branch_id: string | null;
  email: string | null;
  line_target: string | null;
  min_severity: string;
  muted_until: string | null;
  enabled: boolean;
};

type Cache = { loadedAt: number; rows: RecipientRow[] };
let cache: Cache | null = null;

async function loadAll(): Promise<RecipientRow[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.rows;
  }
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const res = await admin
    .from("escalation_recipients")
    .select(
      "role_tier, branch_id, email, line_target, min_severity, muted_until, enabled"
    );
  if (res.error || !res.data) return [];
  cache = { loadedAt: Date.now(), rows: res.data as RecipientRow[] };
  return cache.rows;
}

export function __resetEscalationRecipientsCache(): void {
  cache = null;
}

export type EscalationContacts = {
  emails: string[];
  lineTargets: string[];
  /** Role tiers that actually contributed a contact — for the audit. */
  tiersReached: RoleTier[];
  /** Recipients skipped because they are muted right now. */
  mutedCount: number;
};

/**
 * Resolve the contacts an alert should reach, given the branch, the
 * alert severity, and the escalation tier.
 */
export async function resolveEscalationContacts(opts: {
  branchId: string | null;
  severity: "warning" | "critical";
  tier: EscalationTierName;
}): Promise<EscalationContacts> {
  const rows = await loadAll();
  const wantedRoles = new Set(TIER_ROLES[opts.tier]);
  const now = Date.now();

  const emails = new Set<string>();
  const lineTargets = new Set<string>();
  const tiersReached = new Set<RoleTier>();
  let mutedCount = 0;

  for (const r of rows) {
    if (!r.enabled) continue;
    if (!wantedRoles.has(r.role_tier)) continue;
    // Branch scope: null = all branches; else must match.
    if (r.branch_id && r.branch_id !== opts.branchId) continue;
    // Severity floor — a 'critical'-only contact skips warnings.
    if (r.min_severity === "critical" && opts.severity === "warning") continue;
    // Temporary mute.
    if (r.muted_until && new Date(r.muted_until).getTime() > now) {
      mutedCount += 1;
      continue;
    }
    let contributed = false;
    if (r.email && r.email.trim()) {
      emails.add(r.email.trim().toLowerCase());
      contributed = true;
    }
    if (r.line_target && r.line_target.trim()) {
      lineTargets.add(r.line_target.trim());
      contributed = true;
    }
    if (contributed) tiersReached.add(r.role_tier);
  }

  return {
    emails: [...emails],
    lineTargets: [...lineTargets],
    tiersReached: [...tiersReached],
    mutedCount,
  };
}

// ---------- Admin CRUD helpers ------------------------------------------

export type EscalationRecipientFull = RecipientRow & {
  id: string;
  label: string | null;
  updated_at: string;
};

export async function listEscalationRecipients(): Promise<
  EscalationRecipientFull[]
> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const res = await admin
    .from("escalation_recipients")
    .select(
      "id, role_tier, branch_id, label, email, line_target, min_severity, muted_until, enabled, updated_at"
    )
    .order("role_tier", { ascending: true })
    .order("branch_id", { ascending: true, nullsFirst: true });
  if (res.error || !res.data) return [];
  return res.data as EscalationRecipientFull[];
}
