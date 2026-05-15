// Webhook Audit — the trust layer in front of every inbound provider
// callback (Twilio / Resend / LINE).
//
// Each webhook route calls into this module to:
//   • record the signature verdict + processing outcome
//     (recordWebhookReceipt) — one audit row per call;
//   • detect a re-delivered callback before reprocessing it
//     (isWebhookReplay) — backed by the unique index on
//     (provider, event_id) for accepted rows;
//   • expose invalid-signature + callback-failure counts
//     (webhookMetrics) for the smoke test + workers dashboard.
//
// Best-effort: a broken audit table must never break a webhook —
// the provider would just retry. Every function swallows its own
// errors.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type WebhookProvider = "twilio" | "resend" | "line";

export type WebhookOutcome =
  | "accepted"
  | "invalid_signature"
  | "replay"
  | "malformed"
  | "error";

export type WebhookReceipt = {
  provider: WebhookProvider;
  /** Provider-stable idempotency key. Null only for malformed bodies
   *  where no id could be extracted. */
  eventId: string | null;
  signatureValid: boolean;
  outcome: WebhookOutcome;
  branchId?: string | null;
  callbackLatencyMs?: number | null;
  detail?: Record<string, unknown>;
};

/**
 * Has this exact provider event already been accepted? A `true`
 * means the current call is a re-delivery — acknowledge it 200 but
 * do NOT reprocess.
 */
export async function isWebhookReplay(
  provider: WebhookProvider,
  eventId: string | null
): Promise<boolean> {
  if (!eventId) return false;
  const admin = getSupabaseAdmin();
  if (!admin) return false;
  try {
    const r = await admin
      .from("webhook_audit_log")
      .select("id", { count: "exact", head: true })
      .eq("provider", provider)
      .eq("event_id", eventId)
      .eq("outcome", "accepted");
    return (r.count ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Append one webhook audit row. Best-effort. */
export async function recordWebhookReceipt(
  receipt: WebhookReceipt
): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  try {
    await admin.from("webhook_audit_log").insert({
      provider: receipt.provider,
      event_id: receipt.eventId,
      signature_valid: receipt.signatureValid,
      outcome: receipt.outcome,
      branch_id: receipt.branchId ?? null,
      callback_latency_ms: receipt.callbackLatencyMs ?? null,
      detail: receipt.detail ?? {},
    });
  } catch (err) {
    // A unique-index violation on (provider, event_id, accepted) is
    // the expected outcome of a race between two re-deliveries — it
    // is not an error worth surfacing.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate key|unique/i.test(msg)) {
      console.warn("[webhook-audit] insert failed", msg);
    }
  }
}

export type WebhookMetrics = {
  windowHours: number;
  total: number;
  accepted: number;
  invalidSignature: number;
  replay: number;
  malformed: number;
  error: number;
  /** accepted / total, 0–100; null when no calls in the window. */
  acceptedPct: number | null;
  byProvider: Record<string, { total: number; failed: number }>;
};

/**
 * Aggregate webhook outcomes over the last `windowHours`. "failed"
 * counts everything that is not 'accepted' — invalid signatures,
 * malformed bodies, handler errors. Replays are counted separately
 * (they are benign).
 */
export async function webhookMetrics(
  windowHours = 24
): Promise<WebhookMetrics> {
  const empty: WebhookMetrics = {
    windowHours,
    total: 0,
    accepted: 0,
    invalidSignature: 0,
    replay: 0,
    malformed: 0,
    error: 0,
    acceptedPct: null,
    byProvider: {},
  };
  const admin = getSupabaseAdmin();
  if (!admin) return empty;
  try {
    const since = new Date(
      Date.now() - windowHours * 60 * 60 * 1000
    ).toISOString();
    const r = await admin
      .from("webhook_audit_log")
      .select("provider, outcome")
      .gte("created_at", since)
      .limit(5000);
    const rows = (r.data ?? []) as Array<{
      provider: string;
      outcome: WebhookOutcome;
    }>;
    const m = { ...empty, byProvider: {} as WebhookMetrics["byProvider"] };
    for (const row of rows) {
      m.total += 1;
      if (row.outcome === "accepted") m.accepted += 1;
      else if (row.outcome === "invalid_signature") m.invalidSignature += 1;
      else if (row.outcome === "replay") m.replay += 1;
      else if (row.outcome === "malformed") m.malformed += 1;
      else if (row.outcome === "error") m.error += 1;

      const p = (m.byProvider[row.provider] ??= { total: 0, failed: 0 });
      p.total += 1;
      if (
        row.outcome === "invalid_signature" ||
        row.outcome === "malformed" ||
        row.outcome === "error"
      ) {
        p.failed += 1;
      }
    }
    m.acceptedPct =
      m.total > 0 ? Math.round((m.accepted / m.total) * 1000) / 10 : null;
    return m;
  } catch {
    return empty;
  }
}
