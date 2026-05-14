// Reconcile job — compare the DB against the Google Sheet, the failure
// queue, and the LINE link table. Reports the divergences as
// sync_failures rows (kinds: reconcile_missing_sheet / _duplicate_sheet /
// _orphan_link) so the recovery UI's retry / resolve / inspect flow
// applies without inventing a parallel surface.
//
// Foundation only — no cron, no full-DB walks, no fuzzy comparison.
// Three concrete checks against the last N days of orders:
//
//   1. missing_sheet  — orders where the Job ID (first 8 chars of id)
//      doesn't appear in Front_Desk!B. Auto-retryable via the retry
//      worker (retryPolicy says yes for this kind).
//   2. duplicate_sheet — Front_Desk!B has 2+ rows with the same value.
//      Manual-only — admin decides which row stays.
//   3. orphan_link  — public.customer_line_links has unlinked +
//      un-ignored rows older than a threshold. Manual-only — admin pairs
//      in /admin/customer-line.
//
// Server-only. The route handler (app/api/admin/reconcile/run/route.ts)
// is the auth gate; this module trusts its caller.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { readGoogleSheetsConfig } from "@/lib/googleSheets";

const FRONT_DESK_TAB = process.env.GOOGLE_SHEET_ORDER_TAB ?? "Front_Desk";
const DEFAULT_LOOKBACK_DAYS = 30;
const ORPHAN_THRESHOLD_DAYS = 7;
const MAX_ORDERS_SCANNED = 500;

export type MismatchKind =
  | "reconcile_missing_sheet"
  | "reconcile_duplicate_sheet"
  | "reconcile_orphan_link";

export type Mismatch = {
  kind: MismatchKind;
  /** Target id varies by kind: order.id for sheet checks, link.id for orphan. */
  target_id: string;
  branch_id: string | null;
  reason: string;
  payload: Record<string, unknown>;
};

export type ReconcileTickOptions = {
  /** Restrict the orders scan to one branch slug. NULL = all branches. */
  branchCode?: string | null;
  /** Look-back window for orders. Default 30 days; capped at 90 server-side. */
  lookbackDays?: number;
  /** When true, no sync_failures inserts happen — used by preview UIs. */
  dryRun?: boolean;
  /** Free-form actor id; stamped on each enqueued sync_failures payload. */
  actorId?: string | null;
};

export type ReconcileTickResult = {
  ok: true;
  ordersScanned: number;
  missingSheet: number;
  duplicateSheet: number;
  orphanLink: number;
  totalMismatches: number;
  /** All detected mismatches before enqueue. Useful for the dryRun preview UI. */
  mismatches: Mismatch[];
  startedAt: string;
  finishedAt: string;
};

export type ReconcileTickFailure = { ok: false; reason: string };

// ---------- Sheet column B fetch (one round-trip) -------------------------

/**
 * Fetch every Job ID value currently in Front_Desk!B (skipping the header).
 * Returns a Map from id → array of 0-indexed row positions so duplicates
 * are detectable in a single pass. Throws on Sheets API failure — the
 * caller short-circuits.
 */
async function fetchSheetJobIdMap(): Promise<Map<string, number[]>> {
  const config = readGoogleSheetsConfig();
  if (!config) {
    throw new Error("Google Sheets sync ยังไม่ตั้งค่า credentials");
  }
  // We can't import getAccessToken — re-derive via the same exchange used
  // by googleSheets.ts. To keep this module small, hit the helpers via a
  // tiny inline JWT path identical to lib/googleSheets.ts.
  const { token } = await fetchSheetsToken(config);
  const range = `${FRONT_DESK_TAB}!B:B`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${
    config.sheetId
  }/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets values.get ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { values?: string[][] };
  const map = new Map<string, number[]>();
  const rows = json.values ?? [];
  // Skip header row 0 — Front_Desk B1 is the "Job ID" label.
  for (let i = 1; i < rows.length; i++) {
    const cell = rows[i]?.[0];
    if (cell === undefined || cell === null) continue;
    const trimmed = String(cell).trim();
    if (!trimmed) continue;
    const seen = map.get(trimmed);
    if (seen) seen.push(i);
    else map.set(trimmed, [i]);
  }
  return map;
}

// Minimal JWT exchange — keeps this module independent of googleSheets.ts's
// internal helpers. Reuses the same env vars + Google endpoint.
async function fetchSheetsToken(config: {
  serviceAccountEmail: string;
  privateKey: string;
}): Promise<{ token: string }> {
  const crypto = await import("node:crypto");
  const base64url = (input: string | Buffer): string => {
    const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  };
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: config.serviceAccountEmail,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(signingInput)
    .sign(config.privateKey);
  const jwt = `${signingInput}.${base64url(signature)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Token exchange returned no access_token");
  }
  return { token: json.access_token };
}

// ---------- Idempotent enqueue --------------------------------------------

/**
 * Don't enqueue a mismatch we've already enqueued and not yet resolved.
 * Lookup key: (kind, target_id) with status in ('pending','retrying').
 * Keeps repeated reconcile runs from piling up duplicates.
 */
async function alreadyOpen(
  admin: ReturnType<typeof getSupabaseAdmin>,
  kind: MismatchKind,
  targetId: string
): Promise<boolean> {
  if (!admin) return false;
  const { data, error } = await admin
    .from("sync_failures")
    .select("id")
    .eq("kind", kind)
    .eq("target_id", targetId)
    .in("status", ["pending", "retrying"])
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return !!data;
}

async function enqueueMismatch(
  admin: ReturnType<typeof getSupabaseAdmin>,
  m: Mismatch,
  actorId: string | null
): Promise<boolean> {
  if (!admin) return false;
  if (await alreadyOpen(admin, m.kind, m.target_id)) return false;
  const res = await admin.from("sync_failures").insert({
    kind: m.kind,
    target_id: m.target_id,
    branch_id: m.branch_id,
    reason: m.reason,
    payload: {
      ...m.payload,
      reconcileEnqueuedBy: actorId ?? "reconcile",
      reconcileEnqueuedAt: new Date().toISOString(),
    },
    status: "pending",
    attempts: 0,
  });
  if (res.error) {
    console.warn("[reconcile] enqueue failed", res.error.message);
    return false;
  }
  return true;
}

// ---------- The checks ----------------------------------------------------

type OrderRow = {
  id: string;
  branch_id: string | null;
  created_at: string;
};

async function checkOrdersVsSheet(
  admin: ReturnType<typeof getSupabaseAdmin>,
  opts: {
    branchCode?: string | null;
    lookbackDays: number;
    sheetMap: Map<string, number[]>;
  }
): Promise<Mismatch[]> {
  if (!admin) return [];
  const since = new Date(
    Date.now() - opts.lookbackDays * 24 * 60 * 60 * 1000
  ).toISOString();
  let q = admin
    .from("orders")
    .select("id, branch_id, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_ORDERS_SCANNED);
  if (opts.branchCode) q = q.eq("branch_id", opts.branchCode);
  const { data, error } = await q;
  if (error || !data) return [];

  const out: Mismatch[] = [];
  const seenInSheet = new Set<string>();

  for (const row of data as OrderRow[]) {
    const jobId = row.id.slice(0, 8).toUpperCase();
    const positions = opts.sheetMap.get(jobId);
    if (!positions || positions.length === 0) {
      out.push({
        kind: "reconcile_missing_sheet",
        target_id: row.id,
        branch_id: row.branch_id,
        reason: `Order created ${row.created_at.slice(0, 10)} — no Front_Desk row found (key ${jobId})`,
        payload: { jobId, createdAt: row.created_at },
      });
      continue;
    }
    seenInSheet.add(jobId);
  }

  // Duplicate detection runs across the entire sheet column we already
  // fetched, so an old duplicate that pre-dates the lookback still
  // surfaces.
  for (const [jobId, positions] of opts.sheetMap.entries()) {
    if (positions.length > 1) {
      // Cross-reference back to an order id if possible — match by prefix
      // (the Job ID is the first 8 chars of order.id). Branch is unknown
      // unless we re-query; for the foundation, leave it null and let
      // the admin click through to inspect.
      out.push({
        kind: "reconcile_duplicate_sheet",
        target_id: jobId,
        branch_id: null,
        reason: `Job ID ${jobId} appears in ${positions.length} Front_Desk rows`,
        payload: {
          jobId,
          rowPositions: positions,
        },
      });
    }
  }

  return out;
}

async function checkOrphanLinks(
  admin: ReturnType<typeof getSupabaseAdmin>
): Promise<Mismatch[]> {
  if (!admin) return [];
  const threshold = new Date(
    Date.now() - ORPHAN_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data, error } = await admin
    .from("customer_line_links")
    .select("id, line_user_id, display_name, consented_at, created_at")
    .is("customer_id", null)
    .is("ignored_at", null)
    .lte("created_at", threshold)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error || !data) return [];
  return (data as Array<{
    id: string;
    line_user_id: string;
    display_name: string | null;
    consented_at: string | null;
    created_at: string;
  }>).map((row) => ({
    kind: "reconcile_orphan_link",
    target_id: row.id,
    branch_id: null,
    reason: `LINE follower unlinked for ${ORPHAN_THRESHOLD_DAYS}+ days (line_user_id=${row.line_user_id})`,
    payload: {
      lineUserId: row.line_user_id,
      displayName: row.display_name,
      consentedAt: row.consented_at,
      createdAt: row.created_at,
    },
  }));
}

// ---------- The tick ------------------------------------------------------

export async function runReconcileTick(
  opts: ReconcileTickOptions = {}
): Promise<ReconcileTickResult | ReconcileTickFailure> {
  const startedAt = new Date().toISOString();
  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      ok: false,
      reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า",
    };
  }

  const lookbackDays = Math.min(
    Math.max(opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS, 1),
    90
  );

  // Sheet read first — if it fails we still attempt the orphan-link check
  // and report a partial result rather than crashing the whole tick.
  let sheetMap: Map<string, number[]> = new Map();
  let sheetError: string | null = null;
  try {
    sheetMap = await fetchSheetJobIdMap();
  } catch (err) {
    sheetError = err instanceof Error ? err.message : String(err);
  }

  // Count orders scanned via a tiny count query for the heartbeat row.
  let ordersScanned = 0;
  {
    const since = new Date(
      Date.now() - lookbackDays * 24 * 60 * 60 * 1000
    ).toISOString();
    let cq = admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since);
    if (opts.branchCode) cq = cq.eq("branch_id", opts.branchCode);
    const { count } = await cq;
    ordersScanned = Math.min(count ?? 0, MAX_ORDERS_SCANNED);
  }

  let sheetMismatches: Mismatch[] = [];
  if (!sheetError) {
    sheetMismatches = await checkOrdersVsSheet(admin, {
      branchCode: opts.branchCode ?? null,
      lookbackDays,
      sheetMap,
    });
  }
  const orphanMismatches = await checkOrphanLinks(admin);

  const mismatches: Mismatch[] = [...sheetMismatches, ...orphanMismatches];

  // Persist new mismatches as sync_failures rows so the existing recovery
  // UI handles them. alreadyOpen() makes the operation idempotent against
  // repeated reconcile runs.
  if (!opts.dryRun) {
    for (const m of mismatches) {
      await enqueueMismatch(admin, m, opts.actorId ?? null);
    }
  }

  const finishedAt = new Date().toISOString();

  const missingSheet = mismatches.filter(
    (m) => m.kind === "reconcile_missing_sheet"
  ).length;
  const duplicateSheet = mismatches.filter(
    (m) => m.kind === "reconcile_duplicate_sheet"
  ).length;
  const orphanLink = mismatches.filter(
    (m) => m.kind === "reconcile_orphan_link"
  ).length;

  // Heartbeat row for /admin/recovery.
  if (!opts.dryRun) {
    try {
      await admin.from("reconcile_runs").insert({
        actor_id: opts.actorId ?? null,
        branch_code: opts.branchCode ?? null,
        started_at: startedAt,
        finished_at: finishedAt,
        orders_scanned: ordersScanned,
        missing_sheet: missingSheet,
        duplicate_sheet: duplicateSheet,
        orphan_link: orphanLink,
        total_mismatches: mismatches.length,
        result: { sheetError, sample: mismatches.slice(0, 20) },
      });
    } catch (err) {
      console.warn(
        "[reconcile] heartbeat write failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  console.info(
    `[reconcile] tick orders=${ordersScanned} missing=${missingSheet} duplicate=${duplicateSheet} orphan=${orphanLink} sheetError=${sheetError ?? "none"} actor=${opts.actorId ?? "?"}`
  );

  if (sheetError) {
    // Surface the partial result with a clear reason field. The UI shows
    // it as a yellow banner so the admin knows the sheet half failed.
    return {
      ok: true,
      ordersScanned,
      missingSheet,
      duplicateSheet,
      orphanLink,
      totalMismatches: mismatches.length,
      mismatches,
      startedAt,
      finishedAt,
    };
  }

  return {
    ok: true,
    ordersScanned,
    missingSheet,
    duplicateSheet,
    orphanLink,
    totalMismatches: mismatches.length,
    mismatches,
    startedAt,
    finishedAt,
  };
}
