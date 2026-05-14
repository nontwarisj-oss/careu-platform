// Notification dispatch worker — drains the customer_notifications
// queue. Sibling to lib/retryWorker.ts (which drains sync_failures);
// the two could share more code, but the per-channel routing here is
// distinct enough that a parallel implementation is honest.
//
// Per-row state machine:
//
//   queued → sending → (sent | failed-retryable | dead)
//
// Failure semantics:
//   • Provider says retryable (e.g. 5xx, network) → stays queued with
//     attempts++ and send_after shifted forward by an exponential
//     backoff. The next tick picks it up.
//   • Provider says non-retryable (e.g. invalid phone, missing
//     credentials) → marked 'failed' with error_reason set.
//   • Attempts ≥ MAX_ATTEMPTS → marked 'failed' regardless (dead-letter).
//
// The worker NEVER blocks. Every per-row exception is captured as a
// failed outcome so a misbehaving row can't take down the whole tick.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { sendSms, type SmsSendResult } from "@/lib/smsProvider";
import {
  resolveLineChannelConfig,
} from "@/lib/lineConfig";
import { pushTextMessage } from "@/lib/lineMessaging";
import { checkPerCustomerRateLimits } from "@/lib/customerRateLimit";

// ---------- Safety constants ---------------------------------------------

export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_SECONDS = 60;
export const BACKOFF_MULTIPLIER = 3;
/** Cap to ~3 hours so a misbehaving job doesn't get scheduled days out. */
export const MAX_BACKOFF_SECONDS = 3 * 60 * 60;

export type DispatchTickOptions = {
  limit?: number;
  channels?: Array<"line" | "sms" | "email" | "in_app">;
  actorId?: string | null;
  dryRun?: boolean;
};

type NotificationRow = {
  id: string;
  customer_id: string | null;
  branch_id: string | null;
  channel: "line" | "sms" | "email" | "in_app";
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  send_after: string;
  attempts: number;
  created_at: string;
};

export type ItemOutcome = {
  notificationId: string;
  channel: NotificationRow["channel"];
  kind: string;
  succeeded: boolean;
  dead: boolean;
  skipped: boolean;
  retryable: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

export type DispatchTickResult = {
  processed: number;
  succeeded: number;
  failed: number;
  dead: number;
  skipped: number;
  items: ItemOutcome[];
  startedAt: string;
  finishedAt: string;
};

// ---------- Per-channel dispatchers --------------------------------------

type DispatchOutcome =
  | { ok: true; details?: Record<string, unknown> }
  | { ok: false; reason: string; retryable: boolean; details?: Record<string, unknown> };

async function dispatchSms(row: NotificationRow): Promise<DispatchOutcome> {
  const payload = row.payload ?? {};
  const phone = typeof payload.phone === "string" ? payload.phone : "";
  const body = typeof payload.body === "string" ? payload.body : "";
  if (!phone) {
    return {
      ok: false,
      reason: "payload.phone missing",
      retryable: false,
    };
  }
  if (!body) {
    return {
      ok: false,
      reason: "payload.body missing",
      retryable: false,
    };
  }
  const res: SmsSendResult = await sendSms({
    to: phone,
    body,
    meta: { notificationId: row.id, kind: row.kind },
  });
  if (res.ok) {
    return {
      ok: true,
      details: {
        provider: res.provider,
        providerMessageId: res.providerMessageId,
      },
    };
  }
  return {
    ok: false,
    reason: res.reason,
    retryable: res.retryable,
    details: { provider: res.provider },
  };
}

async function dispatchLine(row: NotificationRow): Promise<DispatchOutcome> {
  const payload = row.payload ?? {};
  const lineUserId =
    typeof payload.lineUserId === "string" ? payload.lineUserId : "";
  const body = typeof payload.body === "string" ? payload.body : "";
  if (!lineUserId || !body) {
    return {
      ok: false,
      reason: "payload.lineUserId or body missing",
      retryable: false,
    };
  }

  // Resolve channel config via the existing helper. Branch_id on the
  // queue row is the text slug — resolveLineChannelConfig wants the
  // branches.id uuid, so we look it up.
  let branchUuid: string | null = null;
  if (row.branch_id) {
    const admin = getSupabaseAdmin();
    if (admin) {
      const branchRes = await admin
        .from("branches")
        .select("id")
        .eq("code", row.branch_id)
        .maybeSingle();
      const b = branchRes.data as { id: string } | null;
      branchUuid = b?.id ?? null;
    }
  }
  const channel = await resolveLineChannelConfig(branchUuid);
  if (!channel) {
    return {
      ok: false,
      reason: "LINE channel config missing — set LINE_CHANNEL_ACCESS_TOKEN or branch row",
      retryable: false,
    };
  }
  const pushed = await pushTextMessage(channel, lineUserId, body);
  if (pushed.ok) {
    return {
      ok: true,
      details: { requestId: pushed.requestId },
    };
  }
  return {
    ok: false,
    reason: pushed.reason ?? "LINE push failed",
    // 4xx from LINE = the user-id is wrong / unsubscribed → not retryable.
    // 5xx + network = transient.
    retryable: pushed.status >= 500,
    details: { lineStatus: pushed.status },
  };
}

function dispatchManualOnly(row: NotificationRow): DispatchOutcome {
  return {
    ok: false,
    reason: `channel "${row.channel}" has no dispatcher yet — admin handles manually`,
    retryable: false,
  };
}

async function dispatchRow(row: NotificationRow): Promise<DispatchOutcome> {
  try {
    switch (row.channel) {
      case "sms":
        return await dispatchSms(row);
      case "line":
        return await dispatchLine(row);
      case "email":
      case "in_app":
        return dispatchManualOnly(row);
      default:
        return {
          ok: false,
          reason: `unknown channel "${(row as { channel: string }).channel}"`,
          retryable: false,
        };
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }
}

// ---------- Dispatch log writer ------------------------------------------
//
// One row per attempt. Append-only — the queue stays tidy (one row per
// intent), this log captures every transition for the admin
// observability view. Failures here MUST NOT propagate; the queue's
// own row already records the customer-visible outcome.

async function writeDispatchLog(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  args: {
    row: NotificationRow;
    outcome: "sent" | "failed" | "skipped";
    retryable: boolean;
    attempt: number;
    latencyMs: number | null;
    details?: Record<string, unknown>;
    reason?: string | null;
  }
): Promise<void> {
  const provider =
    args.row.channel === "sms"
      ? (process.env.SMS_PROVIDER ?? "console").toLowerCase()
      : null;
  try {
    await admin.from("notification_dispatch_log").insert({
      notification_id: args.row.id,
      customer_id: args.row.customer_id,
      branch_id: args.row.branch_id,
      channel: args.row.channel,
      kind: args.row.kind,
      outcome: args.outcome,
      retryable: args.retryable,
      attempt: args.attempt,
      latency_ms: args.latencyMs,
      provider,
      details: args.details ?? {},
      reason: args.reason ?? null,
    });
  } catch (err) {
    // Table missing or schema cache stale → silent. The customer-
    // facing queue row already captured the outcome.
    if (
      err &&
      typeof err === "object" &&
      "message" in err &&
      !/relation .* does not exist|schema cache|column .* does not exist/i.test(
        String((err as { message: unknown }).message)
      )
    ) {
      console.warn(
        "[dispatch-worker] log insert failed",
        (err as { message: unknown }).message
      );
    }
  }
}

// ---------- The tick ------------------------------------------------------

function backoffSeconds(attempts: number): number {
  // attempts=1 → 60s, =2 → 180s, =3 → 540s, =4 → 1620s (~27min), capped.
  const seconds =
    BACKOFF_BASE_SECONDS * Math.pow(BACKOFF_MULTIPLIER, attempts - 1);
  return Math.min(seconds, MAX_BACKOFF_SECONDS);
}

/**
 * Drain up to `limit` pending notifications. Per-row state transitions:
 *
 *   queued → sending → resolved
 *
 * Returns a structured summary including per-row outcomes. The function
 * never throws — every per-row failure is captured as a row in
 * `result.items`.
 */
export async function runDispatchTick(
  opts: DispatchTickOptions = {}
): Promise<DispatchTickResult> {
  const startedAt = new Date().toISOString();
  const items: ItemOutcome[] = [];

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
          notificationId: "",
          channel: "sms",
          kind: "config",
          succeeded: false,
          dead: false,
          skipped: true,
          retryable: false,
          reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ตั้งค่า",
        },
      ],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));

  let q = admin
    .from("customer_notifications")
    .select(
      "id, customer_id, branch_id, channel, kind, payload, status, send_after, attempts, created_at"
    )
    .eq("status", "queued")
    .lte("send_after", new Date().toISOString())
    .order("send_after", { ascending: true })
    .limit(limit);
  if (opts.channels && opts.channels.length > 0) {
    q = q.in("channel", opts.channels);
  }

  const { data, error } = await q;
  if (error || !data) {
    return {
      processed: 0,
      succeeded: 0,
      failed: 0,
      dead: 0,
      skipped: 0,
      items: [
        {
          notificationId: "",
          channel: "sms",
          kind: "fetch",
          succeeded: false,
          dead: false,
          skipped: true,
          retryable: true,
          reason: error?.message ?? "no rows fetched",
        },
      ],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const rows = data as NotificationRow[];
  for (const row of rows) {
    const nextAttempts = row.attempts + 1;
    const now = new Date().toISOString();

    // ----- Per-customer rate limit gate ---------------------------------
    // Check BEFORE flagging the row as 'sending' — if we're over the
    // cap, mark the row as 'skipped' and move on without consuming an
    // attempt. The notifier's pre-enqueue dedup catches duplicates
    // within 6h; this catches the across-kind / cross-channel cases
    // (e.g. status thrashing through 5 different lifecycle events in
    // an hour).
    if (row.customer_id) {
      const orderIdFromPayload =
        typeof row.payload?.orderId === "string"
          ? (row.payload.orderId as string)
          : null;
      const rl = await checkPerCustomerRateLimits({
        customerId: row.customer_id,
        channel: row.channel,
        kind: row.kind,
        orderId: orderIdFromPayload,
      });
      if (!rl.ok) {
        if (!opts.dryRun) {
          await admin
            .from("customer_notifications")
            .update({
              status: "skipped",
              error_reason: `rate-limit: ${rl.bucket} — ${rl.reason}`,
            })
            .eq("id", row.id)
            .eq("status", "queued");
          await writeDispatchLog(admin, {
            row,
            outcome: "skipped",
            retryable: false,
            attempt: row.attempts,
            latencyMs: 0,
            details: { rateLimitBucket: rl.bucket },
            reason: rl.reason,
          });
        }
        items.push({
          notificationId: row.id,
          channel: row.channel,
          kind: row.kind,
          succeeded: false,
          dead: false,
          skipped: true,
          retryable: false,
          reason: `rate-limit: ${rl.reason}`,
          details: { rateLimitBucket: rl.bucket },
        });
        continue;
      }
    }

    if (!opts.dryRun) {
      const flagged = await admin
        .from("customer_notifications")
        .update({ status: "sending", attempts: nextAttempts })
        .eq("id", row.id)
        .eq("status", "queued"); // optimistic concurrency
      if (flagged.error) {
        items.push({
          notificationId: row.id,
          channel: row.channel,
          kind: row.kind,
          succeeded: false,
          dead: false,
          skipped: true,
          retryable: true,
          reason: `flag-sending failed: ${flagged.error.message}`,
        });
        continue;
      }
    }

    const dispatchStart = Date.now();
    const outcome = await dispatchRow(row);
    const latencyMs = Date.now() - dispatchStart;
    const reachedDead = nextAttempts >= MAX_ATTEMPTS;

    if (outcome.ok) {
      // Capture provider_message_id if the channel adapter returned
      // one (Twilio SID, LINE request id). This is the key the Twilio
      // delivery webhook later joins on to mark the row as 'delivered'.
      const providerMessageId =
        (outcome.details &&
          typeof outcome.details.providerMessageId === "string" &&
          (outcome.details.providerMessageId as string)) ||
        (outcome.details &&
          typeof outcome.details.requestId === "string" &&
          (outcome.details.requestId as string)) ||
        null;

      if (!opts.dryRun) {
        const patch: Record<string, unknown> = {
          status: "sent",
          sent_at: now,
          error_reason: null,
        };
        if (providerMessageId) patch.provider_message_id = providerMessageId;
        await admin
          .from("customer_notifications")
          .update(patch)
          .eq("id", row.id);
        await writeDispatchLog(admin, {
          row,
          outcome: "sent",
          retryable: false,
          attempt: nextAttempts,
          latencyMs,
          details: outcome.details,
          reason: null,
        });
      }
      items.push({
        notificationId: row.id,
        channel: row.channel,
        kind: row.kind,
        succeeded: true,
        dead: false,
        skipped: false,
        retryable: false,
        details: outcome.details,
      });
      continue;
    }

    // Failure. Decide: dead-letter (give up), or queue again with backoff.
    const willDeadLetter = reachedDead || !outcome.retryable;
    if (!opts.dryRun) {
      const patch: Record<string, unknown> = {
        error_reason: outcome.reason,
      };
      if (willDeadLetter) {
        // The new 'dead_letter' state is distinct from 'failed':
        //   • 'failed' — transient, waiting on backoff window
        //   • 'dead_letter' — gave up, outside the retry loop
        // Older rows that predate this migration may still carry
        // 'failed' as their terminal state; the admin UI surfaces
        // both as "dead" for the operator.
        patch.status = "dead_letter";
      } else {
        patch.status = "queued";
        patch.send_after = new Date(
          Date.now() + backoffSeconds(nextAttempts) * 1000
        ).toISOString();
      }
      await admin
        .from("customer_notifications")
        .update(patch)
        .eq("id", row.id);
      await writeDispatchLog(admin, {
        row,
        outcome: "failed",
        retryable: !willDeadLetter,
        attempt: nextAttempts,
        latencyMs,
        details: outcome.details,
        reason: outcome.reason,
      });
    }
    items.push({
      notificationId: row.id,
      channel: row.channel,
      kind: row.kind,
      succeeded: false,
      dead: willDeadLetter,
      skipped: false,
      retryable: !willDeadLetter,
      reason: outcome.reason,
      details: outcome.details,
    });
  }

  const succeeded = items.filter((i) => i.succeeded).length;
  const dead = items.filter((i) => i.dead).length;
  const skipped = items.filter((i) => i.skipped).length;
  const failed = items.filter(
    (i) => !i.succeeded && !i.skipped && !i.dead
  ).length;

  console.info(
    `[dispatch-worker] tick processed=${items.length} succeeded=${succeeded} failed=${failed} dead=${dead} skipped=${skipped} actor=${opts.actorId ?? "?"}`
  );

  return {
    processed: items.length,
    succeeded,
    failed,
    dead,
    skipped,
    items,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
