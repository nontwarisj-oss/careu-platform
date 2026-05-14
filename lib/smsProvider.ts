// SMS provider adapter. One interface; multiple implementations behind
// the same shape so we can swap Twilio / a Thai SMS aggregator / any
// future vendor without re-touching the call sites (OTP, dispatch
// worker, etc.).
//
// Selection:
//   • SMS_PROVIDER env var picks the active impl.
//      - undefined / "console" → ConsoleSmsProvider (logs only)
//      - "twilio"  (future) → TwilioSmsProvider
//      - "thai-aggregator" (future) → ThaiAggregatorSmsProvider
//   • The Console impl is the default so a fresh deploy never fails to
//     boot; the OTP code still surfaces in Vercel logs / non-prod UI.
//
// Provider contract is intentionally small: send(text + recipient phone)
// and report success / failure with a short reason. No template-engine,
// no fancy threading — the caller picks the wording.
//
// Server-only.

import { normalizePhone } from "@/lib/phone";

export type SmsSendInput = {
  /** Recipient phone in any reasonable Thai format. Normalised internally. */
  to: string;
  /** Plain-text body. Providers may apply their own length caps. */
  body: string;
  /** Optional context for logging / vendor metadata. */
  meta?: Record<string, unknown>;
};

export type SmsSendResult =
  | { ok: true; provider: string; providerMessageId: string | null }
  | { ok: false; provider: string; reason: string; retryable: boolean };

export interface SmsProvider {
  /** Identifier used in logs + the dispatch worker's audit trail. */
  name: string;
  send(input: SmsSendInput): Promise<SmsSendResult>;
}

// ---------- ConsoleSmsProvider -------------------------------------------
//
// Logs the message via console.info — Vercel function logs capture it,
// dev terminals echo it. Never returns failure. Useful for QA + as a
// production fallback when the real provider is misconfigured (degraded
// but the OTP code still goes to the universal dev value `123456` via
// lib/customerOtp.ts).

class ConsoleSmsProvider implements SmsProvider {
  readonly name = "console";

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const to = normalizePhone(input.to) || input.to;
    console.info(
      `[sms:console] to=${to} body=${JSON.stringify(input.body)}${
        input.meta ? ` meta=${JSON.stringify(input.meta)}` : ""
      }`
    );
    return {
      ok: true,
      provider: this.name,
      providerMessageId: null,
    };
  }
}

// ---------- TwilioSmsProvider (placeholder) ------------------------------
//
// Skeleton kept here so swapping providers is a one-file edit. The real
// implementation hits Twilio's REST API with HTTP Basic auth on the
// Account SID + Auth Token. We deliberately don't pull in the Twilio SDK
// — keeps the runtime lean and the route handler edge-friendly.

class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
    const token = process.env.TWILIO_AUTH_TOKEN ?? "";
    const from = process.env.TWILIO_FROM_NUMBER ?? "";
    if (!sid || !token || !from) {
      return {
        ok: false,
        provider: this.name,
        reason:
          "Twilio not configured — ตั้ง TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER",
        retryable: false,
      };
    }
    const to = normalizePhone(input.to);
    if (!to) {
      return {
        ok: false,
        provider: this.name,
        reason: "เบอร์ปลายทางไม่ถูกต้อง",
        retryable: false,
      };
    }
    // Thai numbers go out in +66 format.
    const e164 = to.startsWith("0") ? `+66${to.slice(1)}` : `+${to}`;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const auth =
      "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: from,
          To: e164,
          Body: input.body,
        }).toString(),
      });
      const text = await res.text();
      if (!res.ok) {
        // 4xx = caller / config issue → not retryable. 5xx = provider
        // hiccup → retryable.
        return {
          ok: false,
          provider: this.name,
          reason: `Twilio ${res.status}: ${text.slice(0, 300)}`,
          retryable: res.status >= 500,
        };
      }
      let providerMessageId: string | null = null;
      try {
        const json = JSON.parse(text) as { sid?: string };
        providerMessageId = json.sid ?? null;
      } catch {
        // Non-JSON success body — happens with mocks; ignore.
      }
      return {
        ok: true,
        provider: this.name,
        providerMessageId,
      };
    } catch (err) {
      return {
        ok: false,
        provider: this.name,
        reason: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }
  }
}

// ---------- Selector ------------------------------------------------------

let cached: SmsProvider | null = null;

/**
 * Resolve the active provider. Cached for the lifetime of the serverless
 * function so each request doesn't re-read the env. Cold-start picks up
 * a config change without redeploy (Vercel restarts on new env values).
 */
export function getSmsProvider(): SmsProvider {
  if (cached) return cached;
  const which = (process.env.SMS_PROVIDER ?? "console").toLowerCase().trim();
  switch (which) {
    case "twilio":
      cached = new TwilioSmsProvider();
      break;
    case "console":
    case "":
    default:
      cached = new ConsoleSmsProvider();
  }
  return cached;
}

/**
 * Convenience — `await sendSms({ to, body })`. Equivalent to
 * `getSmsProvider().send(...)` but cleaner at call sites.
 */
export async function sendSms(input: SmsSendInput): Promise<SmsSendResult> {
  return getSmsProvider().send(input);
}

/** Reset the cache. Test-only — wraps reading the env again on next call. */
export function __resetSmsProviderCache(): void {
  cached = null;
}
