// Alert Routing — delivers a fired alert to operator-facing channels.
//
// Phase 22 shipped this as a SHELL (email/LINE were intent-logged
// stubs). Phase 23 activates real email delivery:
//
//   • Email — sent for real via lib/channels/email (Resend when
//     EMAIL_PROVIDER=resend + EMAIL_API_KEY/EMAIL_FROM; otherwise the
//     console provider logs it — never crashes). One delivery per
//     recipient address.
//   • Slack — ALERT_SLACK_WEBHOOK_URL. Plain HTTPS POST, no SDK.
//   • LINE — internal-notification PLACEHOLDER. Phase 23 logs the
//     intent; a real LINE-to-operator push is a later phase.
//
// Recipients come from lib/alertPreferences (operator-managed). The
// caller (lib/alertEvents) resolves preferences + quiet-hours gating
// BEFORE calling here — this module just sends.
//
// Everything is best-effort. Routing failures never propagate — the
// alert is already persisted; routing is the courtesy layer.
//
// Server-only.

import { sendEmail } from "@/lib/channels/email";

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

export type AlertRouteOutcome = {
  channel: "email" | "slack" | "line";
  recipient: string | null;
  /** Mirrors alert_deliveries.status. */
  status: "sent" | "delivered" | "failed" | "skipped";
  reason: string;
};

export type RouteOptions = {
  /** Email recipient addresses, resolved from alert_preferences. */
  recipients: string[];
  /** True when this is a re-route of an unresolved alert (escalation
   *  cooldown elapsed) rather than the first fire. Affects subject. */
  isEscalation?: boolean;
};

function summarise(a: RoutableAlert): string {
  const cmp = a.comparison === "lt" ? "<" : ">";
  const obs = a.observed == null ? "?" : String(a.observed);
  const thr = a.threshold == null ? "?" : String(a.threshold);
  const branch = a.branchId ? ` [branch: ${a.branchId}]` : "";
  return `[${a.severity.toUpperCase()}] ${a.ruleName}${branch} — ${a.metric} = ${obs} ${cmp} ${thr} (source: ${a.source})`;
}

function subjectFor(a: RoutableAlert, isEscalation: boolean): string {
  const prefix = isEscalation
    ? "⏫ ESCALATION"
    : a.severity === "critical"
      ? "🚨 CRITICAL"
      : "⚠️ Alert";
  return `${prefix} — ${a.ruleName}${a.branchId ? ` (${a.branchId})` : ""}`;
}

function bodyFor(a: RoutableAlert, isEscalation: boolean): string {
  const lines = [
    isEscalation
      ? "An open alert is still unresolved — escalation re-route."
      : "A worker-health alert just fired on the CareU OPS platform.",
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
  const subject = subjectFor(a, opts.isEscalation === true);
  const body = bodyFor(a, opts.isEscalation === true);
  const outcomes: AlertRouteOutcome[] = [];
  for (const to of recipients) {
    try {
      const res = await sendEmail({
        to,
        subject,
        body,
        meta: { kind: "alert", metric: a.metric, severity: a.severity },
      });
      outcomes.push({
        channel: "email",
        recipient: to,
        status: res.ok ? "sent" : "failed",
        reason: res.ok
          ? `provider=${res.provider}`
          : `provider=${res.provider}: ${res.reason}`,
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
  isEscalation: boolean
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
    const prefix = isEscalation
      ? ":arrow_double_up: CareU OPS escalation"
      : ":rotating_light: CareU OPS alert";
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

// ---------- LINE (placeholder) ------------------------------------------

function routeLine(a: RoutableAlert): AlertRouteOutcome {
  const target = (process.env.ALERT_LINE_TARGET ?? "").trim();
  const text = summarise(a);
  console.info(
    `[alert-routing] line internal-notification placeholder${
      target ? ` -> ${target}` : " (no target)"
    }: ${text}`
  );
  return {
    channel: "line",
    recipient: target || null,
    status: "skipped",
    reason: "LINE internal notification placeholder — provider send deferred",
  };
}

/**
 * Route an alert to every channel. The caller has already decided
 * (via lib/alertPreferences) that this alert SHOULD be delivered —
 * routeAlert just sends and reports per-channel outcomes so the
 * caller can persist them into alert_deliveries.
 */
export async function routeAlert(
  a: RoutableAlert,
  opts: RouteOptions
): Promise<AlertRouteOutcome[]> {
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
  outcomes.push(await routeSlack(a, opts.isEscalation === true));
  outcomes.push(routeLine(a));
  return outcomes;
}
