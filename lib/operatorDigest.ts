// Operator Digest — a weekly plain-text summary emailed to operators
// so the health of the business doesn't depend on someone opening a
// dashboard.
//
// Six sections, each best-effort: a failed query degrades that one
// section to "(unavailable)" — the digest still sends.
//
//   1. Weekly sales summary      — dashboard_daily_snapshot (7d)
//   2. Failed jobs summary       — cron_heartbeat_logs + customer_notifications
//   3. Broadcast performance     — broadcast_send_jobs + broadcast_metrics_daily
//   4. CRM engagement summary    — campaign_funnel_metrics (7d)
//   5. Payroll warning summary   — payroll_periods (open + past end_date)
//   6. Branch comparison         — dashboard_daily_snapshot grouped by branch
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/channels/email";
import { branches as ALL_BRANCHES } from "@/lib/brandConfig";

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export type DigestSection = {
  title: string;
  lines: string[];
};

export type OperatorDigest = {
  periodStart: string;
  periodEnd: string;
  subject: string;
  body: string;
  sections: DigestSection[];
};

function thb(n: number): string {
  return `฿${Math.round(n).toLocaleString("en-US")}`;
}

function branchLabel(code: string | null): string {
  if (!code) return "(unassigned)";
  const hit = ALL_BRANCHES.find(
    (b) => b.id === code || b.branchCode === code
  );
  return hit?.shortLabel ?? code;
}

// ---------- Section builders --------------------------------------------

async function sectionWeeklySales(
  admin: Admin,
  sinceDate: string
): Promise<DigestSection> {
  try {
    const r = await admin
      .from("dashboard_daily_snapshot")
      .select("total_orders, completed_orders, revenue, paid_revenue")
      .gte("work_date", sinceDate);
    const rows = (r.data ?? []) as Array<{
      total_orders: number;
      completed_orders: number;
      revenue: number;
      paid_revenue: number;
    }>;
    if (r.error || rows.length === 0) {
      return { title: "Weekly sales", lines: ["(no snapshot data this week)"] };
    }
    const sum = rows.reduce(
      (a, x) => ({
        orders: a.orders + (x.total_orders ?? 0),
        completed: a.completed + (x.completed_orders ?? 0),
        revenue: a.revenue + Number(x.revenue ?? 0),
        paid: a.paid + Number(x.paid_revenue ?? 0),
      }),
      { orders: 0, completed: 0, revenue: 0, paid: 0 }
    );
    return {
      title: "Weekly sales",
      lines: [
        `Orders created : ${sum.orders}`,
        `Orders completed: ${sum.completed}`,
        `Revenue (completed): ${thb(sum.revenue)}`,
        `Revenue (paid)     : ${thb(sum.paid)}`,
      ],
    };
  } catch {
    return { title: "Weekly sales", lines: ["(unavailable)"] };
  }
}

async function sectionFailedJobs(
  admin: Admin,
  sinceIso: string
): Promise<DigestSection> {
  try {
    const cronFail = await admin
      .from("cron_heartbeat_logs")
      .select("cron_name", { count: "exact", head: true })
      .eq("success", false)
      .gte("started_at", sinceIso);
    const notifFail = await admin
      .from("customer_notifications")
      .select("id", { count: "exact", head: true })
      .in("status", ["failed", "dead_letter"])
      .gte("created_at", sinceIso);
    const deadLetter = await admin
      .from("customer_notifications")
      .select("id", { count: "exact", head: true })
      .eq("status", "dead_letter")
      .gte("created_at", sinceIso);
    return {
      title: "Failed jobs",
      lines: [
        `Cron tick failures : ${cronFail.count ?? 0}`,
        `Failed notifications: ${notifFail.count ?? 0}`,
        `Dead-letter rows    : ${deadLetter.count ?? 0}`,
      ],
    };
  } catch {
    return { title: "Failed jobs", lines: ["(unavailable)"] };
  }
}

async function sectionBroadcast(
  admin: Admin,
  sinceIso: string,
  sinceDate: string
): Promise<DigestSection> {
  try {
    const jobs = await admin
      .from("broadcast_send_jobs")
      .select("status")
      .gte("created_at", sinceIso);
    const jobRows = (jobs.data ?? []) as Array<{ status: string }>;
    const byStatus: Record<string, number> = {};
    for (const j of jobRows) {
      byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    }
    const metrics = await admin
      .from("broadcast_metrics_daily")
      .select("sent_count, delivered_count, failed_count")
      .gte("metric_date", sinceDate);
    const mRows = (metrics.data ?? []) as Array<{
      sent_count: number;
      delivered_count: number;
      failed_count: number;
    }>;
    const m = mRows.reduce(
      (a, x) => ({
        sent: a.sent + (x.sent_count ?? 0),
        delivered: a.delivered + (x.delivered_count ?? 0),
        failed: a.failed + (x.failed_count ?? 0),
      }),
      { sent: 0, delivered: 0, failed: 0 }
    );
    const statusLine =
      jobRows.length === 0
        ? "No broadcast jobs this week"
        : Object.entries(byStatus)
            .map(([s, n]) => `${s}:${n}`)
            .join("  ");
    return {
      title: "Broadcast performance",
      lines: [
        `Jobs: ${statusLine}`,
        `Sent ${m.sent} · delivered ${m.delivered} · failed ${m.failed}`,
      ],
    };
  } catch {
    return { title: "Broadcast performance", lines: ["(unavailable)"] };
  }
}

async function sectionCrmEngagement(
  admin: Admin,
  sinceDate: string
): Promise<DigestSection> {
  try {
    const r = await admin
      .from("campaign_funnel_metrics")
      .select(
        "delivered_count, opened_count, clicked_count, quote_started_count, order_count, revenue_thb"
      )
      .gte("metric_date", sinceDate);
    const rows = (r.data ?? []) as Array<{
      delivered_count: number;
      opened_count: number;
      clicked_count: number;
      quote_started_count: number;
      order_count: number;
      revenue_thb: number;
    }>;
    if (r.error || rows.length === 0) {
      return {
        title: "CRM engagement",
        lines: ["(no campaign funnel activity this week)"],
      };
    }
    const s = rows.reduce(
      (a, x) => ({
        delivered: a.delivered + (x.delivered_count ?? 0),
        opened: a.opened + (x.opened_count ?? 0),
        clicked: a.clicked + (x.clicked_count ?? 0),
        quotes: a.quotes + (x.quote_started_count ?? 0),
        orders: a.orders + (x.order_count ?? 0),
        revenue: a.revenue + Number(x.revenue_thb ?? 0),
      }),
      { delivered: 0, opened: 0, clicked: 0, quotes: 0, orders: 0, revenue: 0 }
    );
    return {
      title: "CRM engagement",
      lines: [
        `Delivered ${s.delivered} · opened ${s.opened} · clicked ${s.clicked}`,
        `Quotes started: ${s.quotes}`,
        `Attributed orders: ${s.orders} · revenue ${thb(s.revenue)}`,
      ],
    };
  } catch {
    return { title: "CRM engagement", lines: ["(unavailable)"] };
  }
}

async function sectionPayroll(admin: Admin): Promise<DigestSection> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = await admin
      .from("payroll_periods")
      .select("year, month, end_date, status")
      .eq("status", "open")
      .lt("end_date", today);
    const rows = (r.data ?? []) as Array<{
      year: number;
      month: number;
      end_date: string;
    }>;
    if (rows.length === 0) {
      return {
        title: "Payroll warnings",
        lines: ["No overdue payroll periods — all caught up."],
      };
    }
    return {
      title: "Payroll warnings",
      lines: [
        `${rows.length} payroll period(s) still 'open' past their end date:`,
        ...rows
          .slice(0, 8)
          .map((x) => `  • ${x.year}-${String(x.month).padStart(2, "0")} (ended ${x.end_date})`),
      ],
    };
  } catch {
    return { title: "Payroll warnings", lines: ["(unavailable)"] };
  }
}

async function sectionBranchComparison(
  admin: Admin,
  sinceDate: string
): Promise<DigestSection> {
  try {
    const r = await admin
      .from("dashboard_daily_snapshot")
      .select("branch_code, total_orders, revenue")
      .gte("work_date", sinceDate);
    const rows = (r.data ?? []) as Array<{
      branch_code: string | null;
      total_orders: number;
      revenue: number;
    }>;
    if (r.error || rows.length === 0) {
      return { title: "Branch comparison", lines: ["(no snapshot data)"] };
    }
    const byBranch = new Map<string | null, { orders: number; revenue: number }>();
    for (const x of rows) {
      const cur = byBranch.get(x.branch_code) ?? { orders: 0, revenue: 0 };
      cur.orders += x.total_orders ?? 0;
      cur.revenue += Number(x.revenue ?? 0);
      byBranch.set(x.branch_code, cur);
    }
    const sorted = [...byBranch.entries()].sort(
      (a, b) => b[1].revenue - a[1].revenue
    );
    return {
      title: "Branch comparison",
      lines: sorted.map(
        ([code, v]) =>
          `${branchLabel(code)}: ${v.orders} orders · ${thb(v.revenue)}`
      ),
    };
  } catch {
    return { title: "Branch comparison", lines: ["(unavailable)"] };
  }
}

// ---------- Generator ----------------------------------------------------

export async function generateOperatorDigest(opts?: {
  periodDays?: number;
}): Promise<OperatorDigest> {
  const periodDays = Math.max(1, Math.min(opts?.periodDays ?? 7, 31));
  const now = new Date();
  const since = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  const sinceDate = sinceIso.slice(0, 10);
  const periodStart = sinceDate;
  const periodEnd = now.toISOString().slice(0, 10);

  const admin = getSupabaseAdmin();
  let sections: DigestSection[];
  if (!admin) {
    sections = [
      { title: "Digest", lines: ["service-role client unavailable — digest empty"] },
    ];
  } else {
    sections = [
      await sectionWeeklySales(admin, sinceDate),
      await sectionFailedJobs(admin, sinceIso),
      await sectionBroadcast(admin, sinceIso, sinceDate),
      await sectionCrmEngagement(admin, sinceDate),
      await sectionPayroll(admin),
      await sectionBranchComparison(admin, sinceDate),
    ];
  }

  const subject = `CareU OPS — weekly operator digest (${periodStart} → ${periodEnd})`;
  const body = [
    `CareU OPS — weekly operator digest`,
    `Period: ${periodStart} → ${periodEnd} (${periodDays} days)`,
    "",
    ...sections.flatMap((s) => [
      `## ${s.title}`,
      ...s.lines.map((l) => `  ${l}`),
      "",
    ]),
    `— generated ${now.toISOString()}`,
    `Full dashboards: /admin`,
  ].join("\n");

  return { periodStart, periodEnd, subject, body, sections };
}

// ---------- Sender -------------------------------------------------------

export type DigestSendResult = {
  generated: true;
  recipients: number;
  sent: number;
  failed: number;
  skipped: number;
  periodStart: string;
  periodEnd: string;
};

/**
 * Generate the digest and email it to every recipient across all
 * alert_preferences rows that have digest_enabled. Records one
 * alert_deliveries row per recipient (kind='digest').
 */
export async function sendOperatorDigest(opts?: {
  periodDays?: number;
}): Promise<DigestSendResult> {
  const digest = await generateOperatorDigest(opts);
  const admin = getSupabaseAdmin();

  // Collect digest recipients across all preference scopes.
  let recipients: string[] = [];
  if (admin) {
    try {
      const r = await admin
        .from("alert_preferences")
        .select("recipients, digest_enabled, enabled");
      const rows = (r.data ?? []) as Array<{
        recipients: string[] | null;
        digest_enabled: boolean;
        enabled: boolean;
      }>;
      const set = new Set<string>();
      for (const row of rows) {
        if (row.digest_enabled === false) continue;
        for (const e of row.recipients ?? []) {
          if (e && e.trim()) set.add(e.trim().toLowerCase());
        }
      }
      recipients = [...set];
    } catch {
      recipients = [];
    }
  }

  let sent = 0;
  let failed = 0;
  const skipped = 0;
  const deliveryRows: Array<Record<string, unknown>> = [];

  for (const to of recipients) {
    try {
      const res = await sendEmail({
        to,
        subject: digest.subject,
        body: digest.body,
        meta: { kind: "digest", period: digest.periodStart },
      });
      if (res.ok) sent += 1;
      else failed += 1;
      deliveryRows.push({
        alert_event_id: null,
        kind: "digest",
        channel: res.ok ? (res.provider === "console" ? "console" : "email") : "email",
        recipient: to,
        status: res.ok ? "sent" : "failed",
        branch_id: null,
        detail: {
          provider: res.provider,
          period: `${digest.periodStart}..${digest.periodEnd}`,
          reason: res.ok ? "sent" : res.reason,
        },
      });
    } catch (err) {
      failed += 1;
      deliveryRows.push({
        alert_event_id: null,
        kind: "digest",
        channel: "email",
        recipient: to,
        status: "failed",
        branch_id: null,
        detail: { reason: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Record deliveries (best-effort).
  if (admin && deliveryRows.length > 0) {
    try {
      await admin.from("alert_deliveries").insert(deliveryRows);
    } catch (err) {
      console.warn(
        "[operator-digest] delivery insert failed",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return {
    generated: true,
    recipients: recipients.length,
    sent,
    failed,
    skipped,
    periodStart: digest.periodStart,
    periodEnd: digest.periodEnd,
  };
}
