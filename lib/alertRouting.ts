// Alert Routing — delivers a fired alert to operator-facing channels.
//
// Phase 22 shipped this as a shell. Phase 23 activated real email.
// Phase 24 activates the LINE operator channel and a tiered
// escalation chain:
//
//   • Email — sent via lib/channels/email; one delivery per
//     recipient. Returns the provider message id so the Resend
//     webhook can later confirm true delivery.
//   • Slack — ALERT_SLACK_WEBHOOK_URL, plain HTTPS POST.
//   • LINE  — real push to an operator user / group / room id via the
//     Messaging API (lib/lineMessaging). Token from ALERT_LINE_TOKEN
//     or the global LINE OA. Safe no-op when nothing is configured.
//
// Escalation tier (branch → hq → owner) affects only the subject /
// message prefix here — WHO receives it is decided by the caller
// (lib/alertEvents) when it resolves recipients per tier.
//
// Best-effort: routing failures never propagate.
//
// Server-only.

import { sendEmail } from "@/lib/channels/email";
import { resolveLineChannelConfig } from "@/lib/lineConfig";
import { pushTextMessage } from "@/lib/lineMessaging";

export type RoutableAlert = {
  ruleName: string;
  metric: string;
  severity: "warning" | "critical";
  source: string;
  branchId: string | null;
  observed: number | null;
  threshold: number | null;
  comparison: "gt" | "lt" | null;
};

export type EscalationTier = "alert" | "hq" | "owner";

export type AlertRouteOutcome = {
  channel: "email" | "slack" | "line";
  recipient: string | null;
  /** Mirrors alert_deliveries.status. */
  status: "sent" | "delivered" | "failed" | "skipped";
  reason: string;
  /** Provider message id when the channel returned one (email). Lets
   *  the delivery webhook confirm true delivery later. */
  providerMessageId?: string | null;
};

export type RouteOptions = {
  /** Email recipient addresses, resolved per escalation tier. */
  recipients: string[];
  /** Phase 26: LINE user / group / room ids — the alert fans out to
   *  every target (multiple operators / HQ + branch groups). */
  lineTargets?: string[];
  /** Escalation tier — drives the subject prefix. 'alert' = first
   *  fire; 'hq' / 'owner' = re-routes after the escalation cooldown. */
  tier?: EscalationTier;
};

function summarise(a: RoutableAlert): string {
  const cmp = a.comparison === "lt" ? "<" : ">";
  const obs = a.observed == null ? "?" : String(a.observed);
  const thr = a.threshold == null ? "?" : String(a.threshold);
  const branch = a.branchId ? ` [branch: ${a.branchId}]` : "";
  return `[${a.severity.toUpperCase()}] ${a.ruleName}${branch} — ${a.metric} = ${obs} ${cmp} ${thr} (source: ${a.source})`;
}

function tierPrefix(tier: EscalationTier, severity: string): string {
  switch (tier) {
    case "owner":
      return "⏫⏫ OWNER ESCALATION";
    case "hq":
      return "⏫ HQ ESCALATION";
    default:
      return severity === "critical" ? "🚨 CRITICAL" : "⚠️ Alert";
  }
}

function subjectFor(a: RoutableAlert, tier: EscalationTier): string {
  return `${tierPrefix(tier, a.severity)} — ${a.ruleName}${a.branchId ? ` (${a.branchId})` : ""}`;
}

function bodyFor(a: RoutableAlert, tier: EscalationTier): string {
  const lines = [
    tier === "alert"
      ? "A worker-health alert just fired on the CareU OPS platform."
      : `An open alert is still unresolved — ${tier} escalation re-route.`,
    "",
    summarise(a),
    "",
    `Severity : ${a.severity}`,
    `Metric   : ${a.metric}`,
    `Observed : ${a.observed ?? "?"}`,
    `Threshold: ${a.threshold ?? "?"}`,
    `Branch   : ${a.branchId ?? "(all branches)"}`,
    `Source   : ${a.source}`,
    "",
    "Open the workers dashboard: /admin/system/workers",
  ];
  return lines.join("\n");
}

// ---------- Email --------------------------------------------------------

async function routeEmail(
  a: RoutableAlert,
  opts: RouteOptions
): Promise<AlertRouteOutcome[]> {
  const recipients = (opts.recipients ?? []).filter(
    (r) => r.trim().length > 0
  );
  if (recipients.length === 0) {
    return [
      {
        channel: "email",
        recipient: null,
        status: "skipped",
        reason: "no recipients configured (alert_preferences)",
      },
    ];
  }
  const tier = opts.tier ?? "alert";
  const subject = subjectFor(a, tier);
  const body = bodyFor(a, tier);
  const outcomes: AlertRouteOutcome[] = [];
  for (const to of recipients) {
    try {
      const res = await sendEmail({
        to,
        subject,
        body,
        meta: { kind: "alert", metric: a.metric, severity: a.severity, tier },
      });
      outcomes.push({
        channel: "email",
        recipient: to,
        status: res.ok ? "sent" : "failed",
        reason: res.ok
          ? `provider=${res.provider}`
          : `provider=${res.provider}: ${res.reason}`,
        providerMessageId: res.ok ? res.providerMessageId : null,
      });
    } catch (err) {
      outcomes.push({
        channel: "email",
        recipient: to,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}

// ---------- Slack --------------------------------------------------------

async function routeSlack(
  a: RoutableAlert,
  tier: EscalationTier
): Promise<AlertRouteOutcome> {
  const url = (process.env.ALERT_SLACK_WEBHOOK_URL ?? "").trim();
  const text = summarise(a);
  if (!url) {
    return {
      channel: "slack",
      recipient: null,
      status: "skipped",
      reason: "ALERT_SLACK_WEBHOOK_URL not set",
    };
  }
  try {
    const prefix =
      tier === "alert"
        ? ":rotating_light: CareU OPS alert"
        : `:arrow_double_up: CareU OPS ${tier} escalation`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${prefix}\n${text}` }),
    });
    return {
      channel: "slack",
      recipient: "webhook",
      status: res.ok ? "sent" : "failed",
      reason: res.ok ? "posted" : `Slack responded ${res.status}`,
    };
  } catch (err) {
    return {
      channel: "slack",
      recipient: "webhook",
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------- LINE operator channel ---------------------------------------

async function routeLine(
  a: RoutableAlert,
  opts: RouteOptions
): Promise<AlertRouteOutcome[]> {
  // Phase 26: fan out to EVERY configured LINE target — multiple
  // operators, plus HQ + branch escalation groups. Target set =
  // resolved escalation/preference targets ∪ ALERT_LINE_TARGET env.
  const targets = Array.from(
    new Set(
      [
        ...(opts.lineTargets ?? []),
        (process.env.ALERT_LINE_TARGET ?? "").trim(),
      ]
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    )
  );
  if (targets.length === 0) {
    return [
      {
        channel: "line",
        recipient: null,
        status: "skipped",
        reason:
          "no LINE target (escalation_recipients / alert_preferences / ALERT_LINE_TARGET)",
      },
    ];
  }

  // Token: dedicated ALERT_LINE_TOKEN, else the global LINE OA token.
  const alertToken = (process.env.ALERT_LINE_TOKEN ?? "").trim();
  let token = alertToken;
  if (!token) {
    try {
      const cfg = await resolveLineChannelConfig(null);
      token = cfg?.channelAccessToken ?? "";
    } catch {
      token = "";
    }
  }
  if (!token) {
    return [
      {
        channel: "line",
        recipient: targets.join(","),
        status: "skipped",
        reason: "no LINE channel token (ALERT_LINE_TOKEN / LINE OA)",
      },
    ];
  }

  const tier = opts.tier ?? "alert";
  const text = `${tierPrefix(tier, a.severity)}\n${summarise(a)}\n→ /admin/system/workers`;
  const cfg = {
    origin: "branch" as const,
    channelAccessToken: token,
    channelSecret: null,
    oaBasicId: null,
    oaDisplayName: null,
    branchId: null,
  };
  const outcomes: AlertRouteOutcome[] = [];
  for (const target of targets) {
    try {
      const res = await pushTextMessage(cfg, target, text);
      outcomes.push({
        channel: "line",
        recipient: target,
        status: res.ok ? "sent" : "failed",
        reason: res.ok
          ? `requestId=${res.requestId ?? "?"}`
          : `LINE ${res.status}: ${res.reason}`,
      });
    } catch (err) {
      outcomes.push({
        channel: "line",
        recipient: target,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}

/**
 * Route an alert to every channel. The caller (lib/alertEvents) has
 * already gated on preferences + quiet hours and resolved the
 * recipient set + LINE target for the escalation tier.
 */
export async function routeAlert(
  a: RoutableAlert,
  opts: RouteOptions
): Promise<AlertRouteOutcome[]> {
  const tier = opts.tier ?? "alert";
  const outcomes: AlertRouteOutcome[] = [];
  try {
    outcomes.push(...(await routeEmail(a, opts)));
  } catch (err) {
    outcomes.push({
      channel: "email",
      recipient: null,
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  outcomes.push(await routeSlack(a, tier));
  try {
    outcomes.push(...(await routeLine(a, opts)));
  } catch (err) {
    outcomes.push({
      channel: "line",
      recipient: null,
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return outcomes;
}
