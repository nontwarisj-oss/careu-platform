// Retention Trigger Service — periodic sweep that fires
// promotional/retention messages for at-risk / dormant / VIP /
// first-time customers.
//
// Pipeline:
//
//   cron tick → fetch candidate customers per trigger kind
//             → dedup against retention_trigger_jobs (per-kind window)
//             → evaluate communicationPolicyService (prefs + rate limit
//                 + recipient presence)
//             → evaluate broadcastPolicyService (quiet hours)
//             → render template (lib/emailTemplateService)
//             → enqueueNotification (lib/notificationService)
//             → write retention_trigger_jobs row
//
// Single-customer, per-row dispatch — NOT broadcast fan-out. Each
// trigger creates one customer_notifications row, which the existing
// dispatch worker drains via the regular SMS / LINE / email path.
//
// "Explainable + reversible + safe under retries":
//   • `fired_reason` on every row captures why the trigger matched.
//   • Dedup means a retry runs but no second send.
//   • The cron is idempotent — running twice produces the same rows.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { enqueueNotification } from "@/lib/notificationService";
import { evaluatePolicy } from "@/lib/communicationPolicyService";
import { checkQuietHours } from "@/lib/broadcastPolicyService";
import { renderTemplate, type TemplateRow } from "@/lib/emailTemplateService";
import { branches as ALL_BRANCHES, getBranchById } from "@/lib/brandConfig";
import { resolveNumber } from "@/lib/branchTriggerOverrides";
import { isEmergencyStopped } from "@/lib/engagementGuardrails";

// ---------- Tunables ----------------------------------------------------

/** Per-trigger-kind dedup windows. "We've already fired X for this
 *  customer in the last N days — skip." */
const DEDUP_WINDOW_DAYS: Record<TriggerKind, number> = {
  no_visit_x_days: 30,
  pickup_overdue: 7,
  inactive_vip: 60,
  high_spend_dormant: 90,
  birthday_month: 365,
  first_time_followup: 365,
};

/** How many customers to process per kind per tick. Keeps the cron
 *  responsive even when the at-risk pool is large. */
const PER_KIND_LIMIT = 100;

/** "no visit" threshold (days). */
const NO_VISIT_THRESHOLD = 60;

/** "high-spend dormant" — lifetime spend ≥ this AND dormant. */
const HIGH_SPEND_THRESHOLD_THB = 5000;

/** "first-time followup" — first order completed within last N days. */
const FIRST_TIME_WINDOW_DAYS = 14;

// ---------- Types -------------------------------------------------------

export type TriggerKind =
  | "no_visit_x_days"
  | "pickup_overdue"
  | "inactive_vip"
  | "high_spend_dormant"
  | "birthday_month"
  | "first_time_followup";

const TRIGGER_TEMPLATE_SLUG: Record<TriggerKind, string> = {
  no_visit_x_days: "we_miss_you",
  pickup_overdue: "overdue_pickup_reminder",
  inactive_vip: "vip_reactivation",
  high_spend_dormant: "vip_reactivation",
  birthday_month: "we_miss_you", // operator can change later
  first_time_followup: "thank_you_followup",
};

export type TickOptions = {
  /** Restrict to specific trigger kinds (default = all). */
  kinds?: TriggerKind[];
  /** Override per-kind limit (default 100). */
  perKindLimit?: number;
  /** Override the channel preference (default 'line', fallback 'sms'). */
  channels?: Array<"sms" | "line">;
};

export type TickResult = {
  startedAt: string;
  finishedAt: string;
  perKind: Record<string, {
    candidates: number;
    fired: number;
    deduped: number;
    skipped: number;
    failed: number;
  }>;
  blockedReason: string | null;
};

type CustomerCandidate = {
  id: string;
  name: string | null;
  branch_id: string | null;
  customer_tier: string | null;
  total_orders: number | null;
  lifetime_spend: number | string | null;
  last_visit_at: string | null;
};

// ---------- Tick entry --------------------------------------------------

export async function runRetentionTriggerTick(
  opts: TickOptions = {}
): Promise<TickResult> {
  const startedAt = new Date().toISOString();
  const perKindLimit = opts.perKindLimit ?? PER_KIND_LIMIT;
  const kinds: TriggerKind[] =
    opts.kinds ?? (Object.keys(TRIGGER_TEMPLATE_SLUG) as TriggerKind[]);
  const channels = opts.channels ?? ["line", "sms"];

  const admin = getSupabaseAdmin();
  const perKind: TickResult["perKind"] = {};
  if (!admin) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      perKind,
      blockedReason: "no admin client",
    };
  }

  // Phase 20: emergency stop wins outright. Operator owners can
  // freeze every outbound path with one toggle.
  if (await isEmergencyStopped()) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      perKind,
      blockedReason: "global_emergency_stop=true",
    };
  }

  // Quiet hours: if outside the window, this tick is a no-op. The
  // cron records the reason via heartbeat. (Retention sweep is
  // global-scope; for per-branch quiet hours, the dispatch worker
  // re-checks per row.)
  const quiet = await checkQuietHours();
  if (!quiet.ok) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      perKind,
      blockedReason: quiet.reason,
    };
  }

  // Pre-load the 4 default templates we reference, keyed by slug —
  // avoids one DB round-trip per customer.
  const templates = await loadTemplateMap(admin);

  for (const kind of kinds) {
    perKind[kind] = {
      candidates: 0,
      fired: 0,
      deduped: 0,
      skipped: 0,
      failed: 0,
    };
    const candidates = await fetchCandidates(admin, kind, perKindLimit);
    perKind[kind].candidates = candidates.length;

    for (const c of candidates) {
      // Resolve channel: prefer the first channel the customer hasn't
      // opted out of. The communication policy gate inside the loop
      // does the final check; here we pick a candidate channel for
      // dedup purposes.
      const channel = await pickChannel(admin, c.id, channels);
      if (!channel) {
        perKind[kind].skipped += 1;
        await writeJob(admin, {
          customerId: c.id,
          triggerKind: kind,
          channel: "sms",
          branchId: c.branch_id,
          status: "skipped",
          skipReason: "no available channel (sms / line opt-out or no recipient)",
          firedReason: candidateReason(kind, c),
        });
        continue;
      }

      // Dedup: did we fire the same (customer, kind) within the window?
      const isDup = await alreadyFired(admin, c.id, kind);
      if (isDup) {
        perKind[kind].deduped += 1;
        continue;
      }

      // Policy gate (preferences + rate limit + recipient + per-
      // branch unsubscribe). branchId propagated for Phase 19's
      // per-branch opt-out check.
      const policy = await evaluatePolicy({
        customerId: c.id,
        channel,
        kind: "retention",
        intent: "promotional",
        branchId: c.branch_id,
      });
      if (!policy.ok) {
        perKind[kind].skipped += 1;
        await writeJob(admin, {
          customerId: c.id,
          triggerKind: kind,
          channel,
          branchId: c.branch_id,
          status: "skipped",
          skipReason: `${policy.bucket}: ${policy.reason}`,
          firedReason: candidateReason(kind, c),
        });
        continue;
      }

      // Render the template.
      const templateSlug = TRIGGER_TEMPLATE_SLUG[kind];
      const template = templates[templateSlug] ?? null;
      const context = buildContext(c);
      const rendered = await renderTemplate(
        { templateSlug, context, channel },
        { loadedTemplate: template }
      );
      if (!rendered.ok) {
        perKind[kind].failed += 1;
        await writeJob(admin, {
          customerId: c.id,
          triggerKind: kind,
          channel,
          templateId: template?.id ?? null,
          branchId: c.branch_id,
          status: "failed",
          skipReason: `template render failed: ${rendered.reason}`,
          firedReason: candidateReason(kind, c),
        });
        continue;
      }

      // Recipient address.
      const recipient = await fetchRecipient(admin, c.id, channel);
      if (!recipient) {
        perKind[kind].skipped += 1;
        await writeJob(admin, {
          customerId: c.id,
          triggerKind: kind,
          channel,
          templateId: template?.id ?? null,
          branchId: c.branch_id,
          status: "skipped",
          skipReason: "recipient missing at enqueue time",
          firedReason: candidateReason(kind, c),
        });
        continue;
      }

      // Enqueue + write job row.
      const enq = await enqueueNotification({
        customerId: c.id,
        branchId: c.branch_id,
        channel,
        kind: "retention",
        payload: {
          triggerKind: kind,
          templateSlug,
          body: rendered.body,
          subject: rendered.subject,
          ...(channel === "sms" ? { phone: recipient } : {}),
          ...(channel === "line" ? { lineUserId: recipient } : {}),
        },
      });
      if (!enq.ok) {
        perKind[kind].failed += 1;
        await writeJob(admin, {
          customerId: c.id,
          triggerKind: kind,
          channel,
          templateId: template?.id ?? null,
          branchId: c.branch_id,
          status: "failed",
          skipReason: enq.reason ?? "enqueue failed",
          firedReason: candidateReason(kind, c),
        });
        continue;
      }
      perKind[kind].fired += 1;
      await writeJob(admin, {
        customerId: c.id,
        triggerKind: kind,
        channel,
        templateId: template?.id ?? null,
        notificationId: enq.notificationId,
        branchId: c.branch_id,
        status: "dispatched",
        firedReason: candidateReason(kind, c),
      });
    }
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    perKind,
    blockedReason: null,
  };
}

// ---------- Candidate fetchers ------------------------------------------

async function fetchCandidates(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  kind: TriggerKind,
  limit: number
): Promise<CustomerCandidate[]> {
  const select =
    "id, name, branch_id, customer_tier, total_orders, lifetime_spend, last_visit_at";

  switch (kind) {
    case "no_visit_x_days": {
      const cutoff = new Date(
        Date.now() - NO_VISIT_THRESHOLD * 24 * 60 * 60 * 1000
      ).toISOString();
      const r = await admin
        .from("customers")
        .select(select)
        .lte("last_visit_at", cutoff)
        .gte("total_orders", 1)
        .order("last_visit_at", { ascending: true })
        .limit(limit);
      return (r.data ?? []) as CustomerCandidate[];
    }
    case "pickup_overdue": {
      // Order-driven: find orders in ready-for-pickup past their
      // due_date AND get the unique customers.
      const cutoff = new Date(
        Date.now() - 2 * 24 * 60 * 60 * 1000
      ).toISOString();
      const orderRes = await admin
        .from("orders")
        .select("customer_id, branch_id")
        .eq("status", "ready-for-pickup")
        .lte("updated_at", cutoff)
        .limit(limit * 2);
      if (orderRes.error || !orderRes.data) return [];
      const customerIds = Array.from(
        new Set(
          (orderRes.data as Array<{ customer_id: string | null }>)
            .map((r) => r.customer_id)
            .filter((id): id is string => !!id)
        )
      ).slice(0, limit);
      if (customerIds.length === 0) return [];
      const cr = await admin
        .from("customers")
        .select(select)
        .in("id", customerIds);
      return (cr.data ?? []) as CustomerCandidate[];
    }
    case "inactive_vip": {
      const cutoff = new Date(
        Date.now() - 45 * 24 * 60 * 60 * 1000
      ).toISOString();
      const r = await admin
        .from("customers")
        .select(select)
        .in("customer_tier", ["gold", "platinum", "vip"])
        .lte("last_visit_at", cutoff)
        .order("last_visit_at", { ascending: true })
        .limit(limit);
      return (r.data ?? []) as CustomerCandidate[];
    }
    case "high_spend_dormant": {
      const cutoff = new Date(
        Date.now() - 180 * 24 * 60 * 60 * 1000
      ).toISOString();
      const r = await admin
        .from("customers")
        .select(select)
        .gte("lifetime_spend", HIGH_SPEND_THRESHOLD_THB)
        .lte("last_visit_at", cutoff)
        .order("last_visit_at", { ascending: true })
        .limit(limit);
      return (r.data ?? []) as CustomerCandidate[];
    }
    case "birthday_month": {
      // Phase 19: birthday-month trigger activated.
      // Matches customers whose birth_date month equals the current
      // month AND the customer has confirmed (birth_month_verified=
      // true). Unverified DOBs are skipped to avoid spamming a guess.
      const now = new Date();
      const month = now.getUTCMonth() + 1;
      const r = await admin
        .from("customers")
        .select(select + ", birth_date")
        .eq("birth_month_verified", true)
        .not("birth_date", "is", null)
        .limit(limit * 2);
      if (r.error || !r.data) return [];
      const candidates = (
        r.data as unknown as Array<CustomerCandidate & { birth_date: string | null }>
      )
        .filter((c) => {
          if (!c.birth_date) return false;
          // birth_date is stored as a date; the month part is
          // sufficient. Parse defensively in case it arrives as a
          // string from PG.
          try {
            const m = new Date(c.birth_date).getUTCMonth() + 1;
            return m === month;
          } catch {
            return false;
          }
        })
        .slice(0, limit);
      return candidates;
    }
    case "first_time_followup": {
      const window = new Date(
        Date.now() - FIRST_TIME_WINDOW_DAYS * 24 * 60 * 60 * 1000
      ).toISOString();
      const r = await admin
        .from("customers")
        .select(select)
        .eq("total_orders", 1)
        .gte("last_visit_at", window)
        .order("last_visit_at", { ascending: false })
        .limit(limit);
      return (r.data ?? []) as CustomerCandidate[];
    }
  }
}

// ---------- Dedup -------------------------------------------------------

async function alreadyFired(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  customerId: string,
  kind: TriggerKind
): Promise<boolean> {
  const windowDays = DEDUP_WINDOW_DAYS[kind];
  const since = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const r = await admin
    .from("retention_trigger_jobs")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customerId)
    .eq("trigger_kind", kind)
    .in("status", ["dispatched", "queued"])
    .gte("created_at", since);
  return (r.count ?? 0) > 0;
}

// ---------- Recipient + channel resolution -----------------------------

async function pickChannel(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  customerId: string,
  channels: Array<"sms" | "line">
): Promise<"sms" | "line" | null> {
  // Prefer LINE when the customer has a link; fall back to SMS.
  for (const channel of channels) {
    if (channel === "line") {
      const r = await admin
        .from("customer_line_links")
        .select("line_user_id, unsubscribed_at")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const row = r.data as { line_user_id?: string; unsubscribed_at?: string | null } | null;
      if (row && row.line_user_id && !row.unsubscribed_at) return "line";
    }
    if (channel === "sms") {
      const r = await admin
        .from("customers")
        .select("normalized_phone, phone")
        .eq("id", customerId)
        .maybeSingle();
      const row = r.data as { normalized_phone: string | null; phone: string | null } | null;
      if (row && (row.normalized_phone || row.phone)) return "sms";
    }
  }
  return null;
}

async function fetchRecipient(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  customerId: string,
  channel: "sms" | "line"
): Promise<string | null> {
  if (channel === "sms") {
    const r = await admin
      .from("customers")
      .select("normalized_phone, phone")
      .eq("id", customerId)
      .maybeSingle();
    if (!r.data) return null;
    const row = r.data as { normalized_phone: string | null; phone: string | null };
    return row.normalized_phone || row.phone || null;
  }
  const r = await admin
    .from("customer_line_links")
    .select("line_user_id, unsubscribed_at")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!r.data) return null;
  const row = r.data as { line_user_id: string; unsubscribed_at: string | null };
  if (row.unsubscribed_at) return null;
  return row.line_user_id;
}

// ---------- Helpers -----------------------------------------------------

async function loadTemplateMap(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>
): Promise<Record<string, TemplateRow>> {
  const slugs = Object.values(TRIGGER_TEMPLATE_SLUG);
  const r = await admin
    .from("email_templates")
    .select(
      "id, slug, name, subject, preview_text, body_plain, body_html, variables, channels, enabled, current_version, branch_id, updated_at"
    )
    .in("slug", slugs)
    .eq("enabled", true);
  const map: Record<string, TemplateRow> = {};
  ((r.data ?? []) as TemplateRow[]).forEach((row) => {
    map[row.slug] = row;
  });
  return map;
}

function candidateReason(kind: TriggerKind, c: CustomerCandidate): string {
  const lastVisit = c.last_visit_at ? c.last_visit_at.slice(0, 10) : "ไม่ทราบ";
  const tier = c.customer_tier ?? "—";
  switch (kind) {
    case "no_visit_x_days":
      return `ไม่ได้เข้ามาตั้งแต่ ${lastVisit} (>${NO_VISIT_THRESHOLD} วัน)`;
    case "pickup_overdue":
      return `งาน ready-for-pickup ค้างเกิน 2 วัน`;
    case "inactive_vip":
      return `tier ${tier} ไม่ได้เข้ามาเกิน 45 วัน (last visit ${lastVisit})`;
    case "high_spend_dormant":
      return `lifetime_spend ≥ ${HIGH_SPEND_THRESHOLD_THB} THB และ dormant`;
    case "birthday_month":
      return "อยู่ในเดือนเกิด";
    case "first_time_followup":
      return `เพิ่งสั่งครั้งแรกเมื่อ ${lastVisit}`;
  }
}

function buildContext(c: CustomerCandidate): Record<string, string | number> {
  const branch = c.branch_id
    ? ALL_BRANCHES.find((b) => b.id === c.branch_id) ?? getBranchById(null)
    : getBranchById(null);
  return {
    customer_name: c.name ?? "ลูกค้า",
    branch_name: branch.receiptName,
    last_visit_date: c.last_visit_at
      ? new Date(c.last_visit_at).toLocaleDateString("th-TH", {
          dateStyle: "medium",
        })
      : "ไม่ทราบ",
    job_id: "—",
  };
}

async function writeJob(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  args: {
    customerId: string;
    triggerKind: TriggerKind;
    channel: "sms" | "line" | "email";
    templateId?: string | null;
    notificationId?: string | null;
    branchId: string | null;
    status: "queued" | "dispatched" | "skipped" | "failed";
    skipReason?: string | null;
    firedReason?: string | null;
  }
): Promise<void> {
  try {
    await admin.from("retention_trigger_jobs").insert({
      customer_id: args.customerId,
      trigger_kind: args.triggerKind,
      channel: args.channel,
      template_id: args.templateId ?? null,
      notification_id: args.notificationId ?? null,
      branch_id: args.branchId,
      status: args.status,
      skip_reason: args.skipReason ?? null,
      fired_reason: args.firedReason ?? null,
      processed_at: new Date().toISOString(),
    });
  } catch {
    // Best-effort: a broken trigger_jobs insert mustn't take down
    // the whole cron tick.
  }
}
