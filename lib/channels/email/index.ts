// Email channel adapter — mirrors lib/smsProvider's shape so the
// dispatch worker can route email rows the same way it routes SMS.
//
// Phase 17 ships:
//   • EmailProvider interface
//   • ConsoleEmailProvider (logs to console.info)
//   • Selector via EMAIL_PROVIDER env var
//   • sendEmail() convenience wrapper
//
// Real provider implementations (SendGrid / SES / Postmark / Resend)
// slot into the same interface — the call sites (dispatch worker,
// future broadcast) don't change.
//
// Server-only.

export type EmailSendInput = {
  to: string;
  subject: string;
  /** Plain-text body. Phase 17 keeps email simple — no HTML rendering.
   *  When marketing campaigns land, we'll add an `html` field + a
   *  rendering pipeline. */
  body: string;
  /** Optional context for logging / vendor metadata. */
  meta?: Record<string, unknown>;
};

export type EmailSendResult =
  | { ok: true; provider: string; providerMessageId: string | null }
  | { ok: false; provider: string; reason: string; retryable: boolean };

export interface EmailProvider {
  readonly name: string;
  send(input: EmailSendInput): Promise<EmailSendResult>;
}

// ---------- ConsoleEmailProvider ----------------------------------------
//
// Default. Logs the message via console.info — Vercel function logs
// capture it. Never returns failure. Operators flip EMAIL_PROVIDER
// to the real one when ready.

class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    console.info(
      `[email:console] to=${input.to} subject=${JSON.stringify(input.subject)} body=${JSON.stringify(input.body).slice(0, 200)}${
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

// ---------- ResendEmailProvider (placeholder) ----------------------------
//
// Skeleton for Resend.com — popular Thai-friendly transactional email
// API. Wired but inactive until the operator sets EMAIL_PROVIDER=resend
// + RESEND_API_KEY + EMAIL_FROM.

class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    // EMAIL_API_KEY is the Phase 23 generic name; RESEND_API_KEY is
    // accepted as the legacy fallback so existing deployments keep
    // working without a config change.
    const apiKey =
      process.env.EMAIL_API_KEY ?? process.env.RESEND_API_KEY ?? "";
    const from = process.env.EMAIL_FROM ?? "";
    if (!apiKey || !from) {
      return {
        ok: false,
        provider: this.name,
        reason:
          "Resend not configured — ตั้ง EMAIL_API_KEY (หรือ RESEND_API_KEY) + EMAIL_FROM",
        retryable: false,
      };
    }
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: input.to,
          subject: input.subject,
          text: input.body,
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          provider: this.name,
          reason: `Resend ${res.status}: ${text.slice(0, 300)}`,
          retryable: res.status >= 500,
        };
      }
      let providerMessageId: string | null = null;
      try {
        const json = JSON.parse(text) as { id?: string };
        providerMessageId = json.id ?? null;
      } catch {
        // Non-JSON success body — ignore.
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

let cached: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;
  const which = (process.env.EMAIL_PROVIDER ?? "console")
    .toLowerCase()
    .trim();
  switch (which) {
    case "resend":
      cached = new ResendEmailProvider();
      break;
    case "console":
    case "":
    default:
      cached = new ConsoleEmailProvider();
  }
  return cached;
}

export async function sendEmail(
  input: EmailSendInput
): Promise<EmailSendResult> {
  return getEmailProvider().send(input);
}

/** Test-only — wraps reading the env again on next call. */
export function __resetEmailProviderCache(): void {
  cached = null;
}
