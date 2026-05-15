// Alert Preferences — operator-managed routing config for alert
// delivery. Decides WHO gets an alert, at what severity, and whether
// quiet hours hold a non-critical push back.
//
// Resolution order (most-specific wins), same shape as
// lib/branchTriggerOverrides.ts:
//   1. Per-branch row in alert_preferences.
//   2. Global row (branch_id IS NULL).
//   3. Hard-coded defaults below.
//
// Cached 60s — operators editing /admin/system/alert-preferences see
// the effect within a minute without redeploy.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const CACHE_TTL_MS = 60 * 1000;
const BANGKOK_TZ = "Asia/Bangkok";

export type AlertPreferences = {
  branchId: string | null;
  recipients: string[];
  minSeverity: "warning" | "critical";
  quietHoursStartH: number | null;
  quietHoursEndH: number | null;
  enabled: boolean;
  digestEnabled: boolean;
};

type PrefRow = {
  branch_id: string | null;
  recipients: string[] | null;
  min_severity: string;
  quiet_hours_start_h: number | null;
  quiet_hours_end_h: number | null;
  enabled: boolean;
  digest_enabled: boolean;
};

const DEFAULTS: Omit<AlertPreferences, "branchId"> = {
  recipients: [],
  minSeverity: "warning",
  quietHoursStartH: null,
  quietHoursEndH: null,
  enabled: true,
  digestEnabled: true,
};

type Cache = { loadedAt: number; rows: PrefRow[] };
let cache: Cache | null = null;

async function loadAll(): Promise<PrefRow[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.rows;
  }
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const res = await admin
    .from("alert_preferences")
    .select(
      "branch_id, recipients, min_severity, quiet_hours_start_h, quiet_hours_end_h, enabled, digest_enabled"
    );
  if (res.error || !res.data) return [];
  cache = { loadedAt: Date.now(), rows: res.data as PrefRow[] };
  return cache.rows;
}

export function __resetAlertPreferencesCache(): void {
  cache = null;
}

function rowToPrefs(row: PrefRow): AlertPreferences {
  return {
    branchId: row.branch_id,
    recipients: Array.isArray(row.recipients) ? row.recipients : [],
    minSeverity: row.min_severity === "critical" ? "critical" : "warning",
    quietHoursStartH:
      typeof row.quiet_hours_start_h === "number"
        ? row.quiet_hours_start_h
        : null,
    quietHoursEndH:
      typeof row.quiet_hours_end_h === "number" ? row.quiet_hours_end_h : null,
    enabled: row.enabled !== false,
    digestEnabled: row.digest_enabled !== false,
  };
}

/**
 * Resolve the EFFECTIVE alert preferences for a branch. A per-branch
 * row overrides the global row; absent both, the hard-coded defaults
 * apply.
 *
 * Recipients are MERGED: branch recipients + global recipients,
 * de-duplicated — a branch-scoped alert should reach both the branch
 * manager AND the HQ inbox.
 */
export async function resolveAlertPreferences(
  branchId: string | null
): Promise<AlertPreferences> {
  const rows = await loadAll();
  const globalRow = rows.find((r) => r.branch_id === null);
  const branchRow = branchId
    ? rows.find((r) => r.branch_id === branchId)
    : undefined;

  const global = globalRow ? rowToPrefs(globalRow) : null;
  const branch = branchRow ? rowToPrefs(branchRow) : null;

  // Recipients merge across scopes.
  const recipients = Array.from(
    new Set([
      ...(branch?.recipients ?? []),
      ...(global?.recipients ?? []),
    ])
  ).filter((e) => e.trim().length > 0);

  const pick = <K extends keyof AlertPreferences>(
    key: K
  ): AlertPreferences[K] => {
    if (branch && branchRow && key in branchRow) {
      // branch row exists — use its value for scalar keys.
      return branch[key];
    }
    if (global) return global[key];
    return DEFAULTS[key as keyof typeof DEFAULTS] as AlertPreferences[K];
  };

  return {
    branchId,
    recipients,
    minSeverity: pick("minSeverity"),
    quietHoursStartH: branch
      ? branch.quietHoursStartH
      : (global?.quietHoursStartH ?? DEFAULTS.quietHoursStartH),
    quietHoursEndH: branch
      ? branch.quietHoursEndH
      : (global?.quietHoursEndH ?? DEFAULTS.quietHoursEndH),
    enabled: pick("enabled"),
    digestEnabled: pick("digestEnabled"),
  };
}

function bangkokHour(now: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: BANGKOK_TZ,
      hour: "numeric",
      hour12: false,
    }).formatToParts(now);
    return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  } catch {
    return (now.getUTCHours() + 7) % 24;
  }
}

/** Is `now` inside the prefs' quiet-hours window? */
export function inQuietHours(
  prefs: AlertPreferences,
  now: Date = new Date()
): boolean {
  const { quietHoursStartH: s, quietHoursEndH: e } = prefs;
  if (s == null || e == null) return false;
  const h = bangkokHour(now);
  // Window may wrap past midnight (e.g. 22 → 7).
  return s <= e ? h >= s && h < e : h >= s || h < e;
}

export type DeliveryDecision =
  | { deliver: true }
  | { deliver: false; reason: string };

/**
 * Should an alert of `severity` be PUSHED to operators right now,
 * given the resolved preferences? Critical alerts ignore quiet hours;
 * warnings respect both the severity floor and the quiet window.
 */
export function shouldDeliver(
  prefs: AlertPreferences,
  severity: "warning" | "critical",
  now: Date = new Date()
): DeliveryDecision {
  if (!prefs.enabled) {
    return { deliver: false, reason: "alert delivery disabled for this scope" };
  }
  if (prefs.minSeverity === "critical" && severity === "warning") {
    return {
      deliver: false,
      reason: "below severity threshold (warnings suppressed)",
    };
  }
  if (severity !== "critical" && inQuietHours(prefs, now)) {
    return { deliver: false, reason: "within alert quiet hours" };
  }
  return { deliver: true };
}
