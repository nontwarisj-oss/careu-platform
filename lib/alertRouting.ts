// Alert Routing — delivers a freshly-fired alert to operator-facing
// channels.
//
// Phase 22 ships the routing SHELL. The persisted alert_events row +
// the admin UI are the source of truth; this module is the optional
// "push it to me" layer on top.
//
// Channels + their env switches:
//   • Slack — ALERT_SLACK_WEBHOOK_URL. Slack incoming webhooks are a
//     plain HTTPS POST (no SDK), so when the URL is set we genuinely
//     deliver. When unset we log the intent.
//   • Email — ALERT_EMAIL_TO. Phase 22 does NOT wire a real send (no
//     operator-email provider decision yet) — it logs the intent so
//     the wiring point is obvious for the next phase.
//   • LINE — ALERT_LINE_TARGET. Same: intent-logged, not delivered.
//
// Everything here is best-effort. Routing failures NEVER propagate —
// the alert is already persisted; routing is a courtesy.
//
// Server-only.

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
  channel: "slack" | "email" | "line";
  attempted: boolean;
  delivered: boolean;
  reason: string;
};

function summarise(a: RoutableAlert): string {
  const cmp = a.comparison === "lt" ? "<" : ">";
  const obs = a.observed == null ? "?" : String(a.observed);
  const thr = a.threshold == null ? "?" : String(a.threshold);
  const branch = a.branchId ? ` [branch: ${a.branchId}]` : "";
  return `[${a.severity.toUpperCase()}] ${a.ruleName}${branch} — ${a.metric} = ${obs} ${cmp} ${thr} (source: ${a.source})`;
}

async function routeSlack(a: RoutableAlert): Promise<AlertRouteOutcome> {
  const url = (process.env.ALERT_SLACK_WEBHOOK_URL ?? "").trim();
  const text = summarise(a);
  if (!url) {
    console.info(`[alert-routing] slack (no webhook configured): ${text}`);
    return {
      channel: "slack",
      attempted: false,
      delivered: false,
      reason: "ALERT_SLACK_WEBHOOK_URL not set",
    };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `:rotating_light: CareU OPS alert\n${text}`,
      }),
    });
    return {
      channel: "slack",
      attempted: true,
      delivered: res.ok,
      reason: res.ok ? "posted" : `Slack responded ${res.status}`,
    };
  } catch (err) {
    return {
      channel: "slack",
      attempted: true,
      delivered: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function routeEmailStub(a: RoutableAlert): AlertRouteOutcome {
  const to = (process.env.ALERT_EMAIL_TO ?? "").trim();
  const text = summarise(a);
  if (!to) {
    console.info(`[alert-routing] email (no recipient configured): ${text}`);
    return {
      channel: "email",
      attempted: false,
      delivered: false,
      reason: "ALERT_EMAIL_TO not set",
    };
  }
  // Future-ready: the next phase wires lib/channels/email here. We log
  // the intent so the integration point is unambiguous.
  console.info(`[alert-routing] email -> ${to} (not yet delivered): ${text}`);
  return {
    channel: "email",
    attempted: false,
    delivered: false,
    reason: "email routing prepared but provider send deferred",
  };
}

function routeLineStub(a: RoutableAlert): AlertRouteOutcome {
  const target = (process.env.ALERT_LINE_TARGET ?? "").trim();
  const text = summarise(a);
  if (!target) {
    console.info(`[alert-routing] line (no target configured): ${text}`);
    return {
      channel: "line",
      attempted: false,
      delivered: false,
      reason: "ALERT_LINE_TARGET not set",
    };
  }
  console.info(`[alert-routing] line -> ${target} (not yet delivered): ${text}`);
  return {
    channel: "line",
    attempted: false,
    delivered: false,
    reason: "LINE routing prepared but provider send deferred",
  };
}

/**
 * Route a newly-fired alert to every configured channel. Returns the
 * per-channel outcome so the caller can store it on the alert_events
 * row's `detail.routing` for the audit trail.
 *
 * NOT called for repeat occurrences of an already-open alert — only
 * the first fire routes, so an ongoing incident doesn't spam.
 */
export async function routeAlert(
  a: RoutableAlert
): Promise<AlertRouteOutcome[]> {
  const outcomes: AlertRouteOutcome[] = [];
  try {
    outcomes.push(await routeSlack(a));
  } catch (err) {
    outcomes.push({
      channel: "slack",
      attempted: true,
      delivered: false,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  outcomes.push(routeEmailStub(a));
  outcomes.push(routeLineStub(a));
  return outcomes;
}
