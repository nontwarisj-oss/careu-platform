// Retry worker — the "drain the failure queue" loop. Used by:
//
//   • The /admin/recovery UI's "Retry all pending" button (manual trigger).
//   • A future Supabase Cron / Vercel Cron job (no cron is wired yet —
//     by design for this phase).
//
// Design rules:
//   1. Pure function over the DB. Caller decides role + branch scoping by
//      passing the appropriate filter to `runRetryTick`. The function
//      itself never reads cookies / never enforces auth — its caller
//      (the API route) owns that.
//   2. Bounded work per tick (`limit`) so no single invocation can lock up
//      a serverless function past its timeout.
//   3. Idempotent retries — every dispatch hits a function that handles
//      "we already did this" cleanly (Sheet dedup, LINE append-only log,
//      receipt rebuild is a pure read).
//   4. Strict per-row safety:
//        • Honours a per-row cooldown (LAST_ATTEMPT_BACKOFF_SECONDS).
//        • Caps attempts at MAX_ATTEMPTS — beyond that, status='dead'.
//        • Never throws — every failure is captured in the result so
//          partial successes are observable.
//   5. Server-only. Imports `getSupabaseAdmin`, the order sync core, and
//      the LINE orchestrators directly. Never imports React.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type { SyncFailureRow } from "@/lib/recoveryService";
import { syncOrderToSheetCore } from "@/lib/orderSheetSync";
import { getRetryPolicy } from "@/lib/retryPolicy";
import {
  sendOrderCreatedMessage,
  sendOrderReadyMessage,
  sendPickupReminderMessage,
  sendReceiptMessage,
  type LineMessageKind,
} from "@/lib/lineDelivery";

// ---------- Safety limits (legacy fallback) -------------------------------
//
// As of 2026-05-14 per-kind policy in lib/retryPolicy.ts overrides these
// for any known kind. They remain exported so older callers keep building
// and so the policy module has sane defaults to fall back to.

/** @deprecated use `getRetryPolicy(kind).maxAttempts` instead. */
export const MAX_ATTEMPTS = 5;

/** @deprecated use `getRetryPolicy(kind).cooldownSeconds` instead. */
export const LAST_ATTEMPT_BACKOFF_SECONDS = 60;

// ---------- Public types --------------------------------------------------

export type RetryTickOptions = {
  /** Max rows to process this tick. Hard-capped at 50 to keep one
   *  serverless invocation within timeout. */
  limit?: number;
  /** Subset of kinds to consider; null = all kinds the worker knows. */
  kinds?: SyncFailureRow["kind"][] | null;
  /** When set, restrict to a single branch (text slug). Branch-scoped
   *  callers pass their own branch_code here. */
  branchCode?: string | null;
  /** Free-form actor id for audit. Resolved by the calling API route. */
  actorId?: string | null;
  /** When true, no DB writes happen — used by future preview UIs. */
  dryRun?: boolean;
};

export type RetryItemOutcome = {
  failureId: string;
  kind: SyncFailureRow["kind"];
  targetId: string | null;
  /** True when the dispatcher reports success and the row was resolved. */
  succeeded: boolean;
  /** True when the row was permanently failed (attempts >= MAX_ATTEMPTS). */
  dead: boolean;
  /** True when the dispatcher returned an error but attempts remain. */
  pendingRetry: boolean;
  /** True when the row was skipped without a dispatch attempt (cooldown,
   *  unsupported kind). */
  skipped: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

export type RetryTickResult = {
  processed: number;
  succeeded: number;
  failed: number;
  dead: number;
  skipped: number;
  items: RetryItemOutcome[];
  startedAt: string;
  finishedAt: string;
};

// ---------- The dispatcher ------------------------------------------------

type DispatchResult =
  | { ok: true; details?: Record<string, unknown> }
  | { ok: false; reason: string; details?: Record<string, unknown> };

/**
 * Decide what to do with a single failure row based on `kind` and call the
 * corresponding service. Never throws — wraps every dispatcher call in a
 * try/catch and returns a structured outcome.
 *
 * Supported today:
 *   • order_to_sheet  → syncOrderToSheetCore(targetId)
 *   • line_send       → resolves messageKind from payload, calls the
 *                       matching LINE orchestrator
 *   • receipt_rebuild → no-op success (the helper is a pure read and is
 *                       used today only via the admin UI; the worker
 *                       marks the row resolved so it leaves the queue)
 *
 * Manual-only (returns `ok: false, reason: "manual retry only"`):
 *   • pricing_to_sheet — admin presses "Sync to Sheet" on /pricing.
 *   • customer_from_sheet / expense_from_sheet — admin imports flow.
 *   • debug_to_sheet — diagnostic, never auto-retried.
 */
export async function retryFailureItem(
  row: SyncFailureRow,
  ctx: { actorId?: string | null } = {}
): Promise<DispatchResult> {
  try {
    switch (row.kind) {
      case "order_to_sheet": {
        if (!row.target_id) {
          return { ok: false, reason: "missing target_id" };
        }
        const result = await syncOrderToSheetCore(row.target_id);
        if (!result.ok) {
          return { ok: false, reason: result.reason };
        }
        return {
          ok: true,
          details: {
            sheet: result.sheet,
            rowIndex: result.rowIndex,
            mode: result.mode,
          },
        };
      }

      case "line_send": {
        if (!row.target_id) {
          return { ok: false, reason: "missing target_id" };
        }
        const payloadKind =
          (row.payload as { messageKind?: LineMessageKind } | null | undefined)
            ?.messageKind ?? "receipt";
        const result = await dispatchLineKind(
          payloadKind,
          row.target_id,
          ctx.actorId ?? null
        );
        if (!result.ok) {
          return {
            ok: false,
            reason: result.reason ?? `LINE retry failed (${result.status})`,
            details: { lineStatus: result.status },
          };
        }
        return {
          ok: true,
          details: {
            lineStatus: result.status,
            messageKind: payloadKind,
          },
        };
      }

      case "receipt_rebuild": {
        // No backend writer today — the rebuild is a pure read from the
        // /admin/recovery UI. Marking the queue row resolved is the
        // honest outcome: there's nothing left to do.
        return {
          ok: true,
          details: { note: "receipt_rebuild is client-driven; row resolved" },
        };
      }

      case "pricing_to_sheet":
      case "customer_from_sheet":
      case "expense_from_sheet":
      case "debug_to_sheet":
        return {
          ok: false,
          reason: `manual retry only — kind "${row.kind}" has no auto-retry path`,
        };

      default:
        return {
          ok: false,
          reason: `unknown kind "${(row as { kind: string }).kind}"`,
        };
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function dispatchLineKind(
  kind: LineMessageKind,
  orderId: string,
  actorId: string | null
): Promise<{ ok: boolean; status: string; reason?: string }> {
  const ctx = { actorId: actorId ?? undefined };
  let result;
  switch (kind) {
    case "order_received":
      result = await sendOrderCreatedMessage(orderId, ctx);
      break;
    case "order_ready":
      result = await sendOrderReadyMessage(orderId, ctx);
      break;
    case "pickup_reminder":
      result = await sendPickupReminderMessage(orderId, ctx);
      break;
    case "receipt":
      result = await sendReceiptMessage(orderId, ctx);
      break;
    default:
      return { ok: false, status: "unknown", reason: `unknown LINE kind "${kind}"` };
  }
  if (result.ok) {
    return { ok: true, status: result.status };
  }
  // status: "skipped" | "failed" — skipped is NOT a hard failure (no LINE
  // link / unsubscribed). Treat it as a non-retryable success for the
  // worker so we stop bothering the row.
  if (result.status === "skipped") {
    return { ok: true, status: "skipped", reason: result.reason };
  }
  return { ok: false, status: result.status, reason: result.reason };
}

// ---------- The tick ------------------------------------------------------

/**
 * Drain up to `limit` pending sync_failures rows, applying the dispatcher
 * to each and updating attempts / status / payload.
 *
 * Per-row state machine:
 *   pending → retrying → resolved   (dispatcher OK)
 *   pending → retrying → pending    (dispatcher failed, attempts < MAX)
 *   pending → retrying → dead       (dispatcher failed, attempts >= MAX)
 *   any → SKIPPED (returned in result.items but no DB write)
 *
 * The worker NEVER blocks the storefront — even a catastrophic dispatcher
 * exception lands as `ok: false, reason: ...` on the outcome row.
 */
export async function runRetryTick(
  opts: RetryTickOptions = {}
): Promise<RetryTickResult> {
  const startedAt = new Date().toISOString();
  const items: RetryItemOutcome[] = [];

  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      processed: 0,
      succeeded: 0,
      failed: 0,
      dead: 0,
      skipped: 0,
      items: [
        {
          failureId: "",
          kind: "order_to_sheet",
          targetId: null,
          succeeded: false,
          dead: false,
          pendingRetry: false,
          skipped: true,
          reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ตั้งค่า",
        },
      ],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 25, 50));

  // Pull candidate rows. We deliberately include `retrying` too in case a
  // previous tick crashed mid-flight — the cooldown check still protects
  // against accidental hammering.
  let query = admin
    .from("sync_failures")
    .select(
      "id, kind, target_id, payload, reason, branch_id, attempts, status, last_attempt_at, created_at, resolved_at"
    )
    .in("status", ["pending", "retrying"])
    .order("created_at", { ascending: true })
    .limit(limit);

  if (opts.kinds && opts.kinds.length > 0) {
    query = query.in("kind", opts.kinds);
  }
  if (opts.branchCode) {
    query = query.eq("branch_id", opts.branchCode);
  }

  const { data, error } = await query;
  if (error || !data) {
    return {
      processed: 0,
      succeeded: 0,
      failed: 0,
      dead: 0,
      skipped: 0,
      items: [
        {
          failureId: "",
          kind: "order_to_sheet",
          targetId: null,
          succeeded: false,
          dead: false,
          pendingRetry: false,
          skipped: true,
          reason: error?.message ?? "no rows returned",
        },
      ],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const rows = data as SyncFailureRow[];
  const nowMs = Date.now();

  for (const row of rows) {
    const policy = getRetryPolicy(row.kind);

    // Manual-only kinds — worker never touches state, just records the
    // skip so the admin UI can show why the row wasn't picked up.
    if (!policy.autoRetry) {
      items.push({
        failureId: row.id,
        kind: row.kind,
        targetId: row.target_id,
        succeeded: false,
        dead: false,
        pendingRetry: true,
        skipped: true,
        reason: `manual-only kind "${row.kind}" — worker leaves it for admin resolution`,
      });
      continue;
    }

    // Already at the cap — promote to `dead` without dispatching. Stops
    // the row from re-queuing forever.
    if ((row.attempts ?? 0) >= policy.maxAttempts) {
      if (!opts.dryRun) {
        await admin
          .from("sync_failures")
          .update({
            status: "dead",
            payload: {
              ...(row.payload ?? {}),
              deadReason: `exceeded maxAttempts (${policy.maxAttempts}) for kind ${row.kind}`,
              deadAt: new Date().toISOString(),
            },
          })
          .eq("id", row.id);
      }
      items.push({
        failureId: row.id,
        kind: row.kind,
        targetId: row.target_id,
        succeeded: false,
        dead: true,
        pendingRetry: false,
        skipped: false,
        reason: `attempts ${row.attempts ?? 0} ≥ maxAttempts ${policy.maxAttempts}`,
      });
      continue;
    }

    // Cooldown gate — refuse to hammer a row that was just attempted.
    // Uses the per-kind cooldown (LINE 5min, sheets 30s, …).
    const cooldownMs = policy.cooldownSeconds * 1000;
    if (row.last_attempt_at && cooldownMs > 0) {
      const ageMs = nowMs - new Date(row.last_attempt_at).getTime();
      if (ageMs < cooldownMs) {
        items.push({
          failureId: row.id,
          kind: row.kind,
          targetId: row.target_id,
          succeeded: false,
          dead: false,
          pendingRetry: true,
          skipped: true,
          reason: `cooldown — ${Math.round((cooldownMs - ageMs) / 1000)}s remaining (policy ${policy.cooldownSeconds}s)`,
        });
        continue;
      }
    }

    const nextAttempts = (row.attempts ?? 0) + 1;
    const lastAttemptAt = new Date().toISOString();

    if (!opts.dryRun) {
      // Mark retrying before the dispatch so concurrent ticks see the row
      // in-flight. The cooldown gate above protects against accidental
      // parallel work on the same row.
      const flagged = await admin
        .from("sync_failures")
        .update({
          status: "retrying",
          attempts: nextAttempts,
          last_attempt_at: lastAttemptAt,
        })
        .eq("id", row.id);
      if (flagged.error) {
        items.push({
          failureId: row.id,
          kind: row.kind,
          targetId: row.target_id,
          succeeded: false,
          dead: false,
          pendingRetry: true,
          skipped: true,
          reason: `flag-retrying failed: ${flagged.error.message}`,
        });
        continue;
      }
    }

    const outcome = await retryFailureItem(
      { ...row, attempts: nextAttempts, last_attempt_at: lastAttemptAt },
      { actorId: opts.actorId ?? null }
    );

    if (outcome.ok) {
      if (!opts.dryRun) {
        const merged: Record<string, unknown> = {
          ...(row.payload ?? {}),
          autoResolvedBy: opts.actorId ?? "retry-worker",
          autoResolvedAt: lastAttemptAt,
          lastRetryDetails: outcome.details ?? null,
        };
        const resolveRes = await admin
          .from("sync_failures")
          .update({
            status: "resolved",
            resolved_at: lastAttemptAt,
            payload: merged,
          })
          .eq("id", row.id);
        if (resolveRes.error) {
          // Mark as a pending retry so the next tick re-evaluates. The
          // actual work succeeded (sheet wrote / LINE sent); only the
          // bookkeeping failed. Operator sees the dispatcher succeeded
          // via the included details.
          items.push({
            failureId: row.id,
            kind: row.kind,
            targetId: row.target_id,
            succeeded: false,
            dead: false,
            pendingRetry: true,
            skipped: false,
            reason: `dispatch ok but resolve-mark failed: ${resolveRes.error.message}`,
            details: outcome.details,
          });
          continue;
        }
      }
      items.push({
        failureId: row.id,
        kind: row.kind,
        targetId: row.target_id,
        succeeded: true,
        dead: false,
        pendingRetry: false,
        skipped: false,
        details: outcome.details,
      });
      continue;
    }

    // Dispatcher said no. Decide: dead or pending again? Use the
    // per-kind cap so LINE rows die faster than Sheet rows.
    const reachedDead = nextAttempts >= policy.maxAttempts;
    if (!opts.dryRun) {
      const mergedPayload: Record<string, unknown> = {
        ...(row.payload ?? {}),
        lastRetryReason: outcome.reason ?? null,
        lastRetryBy: opts.actorId ?? "retry-worker",
        lastRetryAt: lastAttemptAt,
      };
      await admin
        .from("sync_failures")
        .update({
          status: reachedDead ? "dead" : "pending",
          payload: mergedPayload,
        })
        .eq("id", row.id);
    }
    items.push({
      failureId: row.id,
      kind: row.kind,
      targetId: row.target_id,
      succeeded: false,
      dead: reachedDead,
      pendingRetry: !reachedDead,
      skipped: false,
      reason: outcome.reason,
    });
  }

  const succeeded = items.filter((i) => i.succeeded).length;
  const dead = items.filter((i) => i.dead).length;
  const skipped = items.filter((i) => i.skipped).length;
  const failed = items.filter(
    (i) => !i.succeeded && !i.skipped && !i.dead
  ).length;
  const finishedAt = new Date().toISOString();

  console.info(
    `[retry-worker] tick processed=${items.length} succeeded=${succeeded} failed=${failed} dead=${dead} skipped=${skipped} actor=${opts.actorId ?? "?"}`
  );

  // Heartbeat row in public.worker_runs so /admin/recovery can show
  // "last cron tick: 3m ago • succeeded 4 / failed 1 / dead 0 / skipped 2".
  // Best-effort: a failed insert MUST NOT mask the work the worker just did.
  if (!opts.dryRun) {
    try {
      await admin.from("worker_runs").insert({
        worker_kind: "retry_tick",
        actor_id: opts.actorId ?? null,
        branch_code: opts.branchCode ?? null,
        started_at: startedAt,
        finished_at: finishedAt,
        processed: items.length,
        succeeded,
        failed,
        dead,
        skipped,
        // Trim items to keep the row from getting massive when a cron tick
        // processes 50 rows. Per-row reason/details stay; the typed flags
        // are enough for the admin UI summary.
        result: { items },
      });
    } catch (err) {
      console.warn(
        "[retry-worker] heartbeat write failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return {
    processed: items.length,
    succeeded,
    failed,
    dead,
    skipped,
    items,
    startedAt,
    finishedAt,
  };
}
