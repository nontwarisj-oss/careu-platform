// Broadcast Send Worker — fans out a broadcast_send_job into the
// existing customer_notifications queue.
//
// Architecture:
//
//   ┌─────────────────────────┐
//   │ broadcast_send_jobs     │  ← created by /api/admin/crm/broadcasts/[id]/send
//   └────────────┬────────────┘
//                │
//          first tick fan-out
//                │
//                ▼
//   ┌─────────────────────────┐
//   │ broadcast_send_targets  │  one row per (job, customer, channel)
//   └────────────┬────────────┘
//                │
//   per-tick chunk processing
//                │
//                ▼
//   ┌─────────────────────────┐
//   │ customer_notifications  │  ← the existing dispatch queue
//   └─────────────────────────┘
//
// Per-tick contract:
//   1. Check feature flags + quiet hours + schedule. Bail with
//      blocked_reason if any fails.
//   2. If targets don't exist yet (first run): compute the audience
//      via crmSegmentationService, validate the cap, INSERT targets
//      (one per (customer, channel)) with status='pending'. Set
//      expected_total on the job.
//   3. Pick up to CHUNK_SIZE pending targets, in deterministic
//      order. For each target:
//        a. Apply communicationPolicyService (preferences + rate
//           limit) + broadcastPolicyService (cross-draft dedup).
//        b. On skip: mark target status='skipped' with reason.
//        c. On ok: enqueueNotification + mark target dispatched.
//   4. Update job metrics + check completion.
//
// The worker NEVER throws. Per-target failures are captured per row.
// Per-tick failures are captured in broadcast_send_attempts.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { enqueueNotification } from "@/lib/notificationService";
import {
  estimateAudience,
  type SegmentDefinition,
} from "@/lib/crmSegmentationService";
import { evaluatePolicy } from "@/lib/communicationPolicyService";
import {
  checkQuietHours,
  checkSchedule,
  isRecentlyBroadcasted,
  isChannelEnabled,
} from "@/lib/broadcastPolicyService";
import { getNumberFlag, FLAG_KEYS } from "@/lib/featureFlags";
import { renderNotification } from "@/lib/notificationTemplates";
import { branches as ALL_BRANCHES, getBranchById } from "@/lib/brandConfig";

const CHUNK_SIZE = 50;

type SendJob = {
  id: string;
  draft_id: string;
  segment_snapshot: SegmentDefinition;
  template_sms_snapshot: string | null;
  template_line_snapshot: string | null;
  channels: string[];
  branch_id: string | null;
  scheduled_for: string | null;
  started_at: string | null;
  status: string;
  mode: "live" | "dry_run";
  expected_total: number | null;
  created_at: string;
};

export type TickOptions = {
  /** Limit how many jobs the tick processes. Defaults to 5 jobs per tick. */
  jobLimit?: number;
  actorId?: string | null;
};

export type TickJobResult = {
  jobId: string;
  status: string;
  processed: number;
  dispatched: number;
  skipped: number;
  failed: number;
  blockedReason: string | null;
  durationMs: number;
};

export type TickResult = {
  startedAt: string;
  finishedAt: string;
  jobs: TickJobResult[];
};

// ---------- Helpers ------------------------------------------------------

function resolveBrand(branchSlug: string | null) {
  if (!branchSlug) return getBranchById(null);
  const hit = ALL_BRANCHES.find(
    (b) =>
      b.id === branchSlug ||
      b.branchCode === branchSlug ||
      b.shortName.toLowerCase() === branchSlug.toLowerCase()
  );
  return hit ?? getBranchById(null);
}

// ---------- Per-tick entry point ----------------------------------------

export async function runBroadcastSendTick(
  opts: TickOptions = {}
): Promise<TickResult> {
  const startedAt = new Date().toISOString();
  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      jobs: [],
    };
  }

  const jobLimit = Math.max(1, Math.min(opts.jobLimit ?? 5, 25));

  // Pick up to jobLimit jobs that are "ready". "Ready" =
  // status IN (queued, processing) AND (scheduled_for IS NULL OR
  // scheduled_for <= now). We sort by scheduled_for so the oldest
  // queued runs first.
  const ready = await admin
    .from("broadcast_send_jobs")
    .select(
      "id, draft_id, segment_snapshot, template_sms_snapshot, template_line_snapshot, channels, branch_id, scheduled_for, started_at, status, mode, expected_total, created_at"
    )
    .in("status", ["queued", "processing"])
    .or(`scheduled_for.is.null,scheduled_for.lte.${new Date().toISOString()}`)
    .order("scheduled_for", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(jobLimit);
  if (ready.error) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      jobs: [],
    };
  }
  const jobs = (ready.data ?? []) as SendJob[];

  const results: TickJobResult[] = [];
  for (const job of jobs) {
    const r = await processJobTick(admin, job, opts.actorId ?? null);
    results.push(r);
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    jobs: results,
  };
}

// ---------- One job, one tick -------------------------------------------

async function processJobTick(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  job: SendJob,
  actorId: string | null
): Promise<TickJobResult> {
  const tickStart = Date.now();
  const attempt: TickJobResult = {
    jobId: job.id,
    status: job.status,
    processed: 0,
    dispatched: 0,
    skipped: 0,
    failed: 0,
    blockedReason: null,
    durationMs: 0,
  };

  const recordAttempt = async (blockedReason?: string | null) => {
    attempt.durationMs = Date.now() - tickStart;
    await admin.from("broadcast_send_attempts").insert({
      send_job_id: job.id,
      targets_processed: attempt.processed,
      dispatched_count: attempt.dispatched,
      skipped_count: attempt.skipped,
      failed_count: attempt.failed,
      blocked_reason: blockedReason ?? null,
      duration_ms: attempt.durationMs,
      finished_at: new Date().toISOString(),
    });
  };

  // 1. Schedule gate.
  const schedule = await checkSchedule({ scheduledFor: job.scheduled_for });
  if (!schedule.ok) {
    attempt.blockedReason = schedule.reason;
    await recordAttempt(schedule.reason);
    return attempt;
  }

  // 2. Quiet hours.
  const quiet = await checkQuietHours();
  if (!quiet.ok) {
    attempt.blockedReason = quiet.reason;
    await recordAttempt(quiet.reason);
    return attempt;
  }

  // 3. First-run fan-out: create targets if none exist yet.
  if (!job.expected_total) {
    const fanOut = await fanOutTargets(admin, job);
    if (!fanOut.ok) {
      await admin
        .from("broadcast_send_jobs")
        .update({
          status: "failed",
          failure_reason: fanOut.reason,
        })
        .eq("id", job.id);
      attempt.blockedReason = fanOut.reason;
      attempt.status = "failed";
      await recordAttempt(fanOut.reason);
      return attempt;
    }
    await admin
      .from("broadcast_send_jobs")
      .update({
        status: "processing",
        started_at: job.started_at ?? new Date().toISOString(),
        expected_total: fanOut.expectedTotal,
      })
      .eq("id", job.id);
    job.expected_total = fanOut.expectedTotal;
    job.status = "processing";
    job.started_at = job.started_at ?? new Date().toISOString();
    await admin.from("broadcast_audit_log").insert({
      draft_id: job.draft_id,
      action: "send_started",
      actor_id: actorId,
      after_value: { send_job_id: job.id, expected_total: fanOut.expectedTotal },
    });
  }

  // 4. Pick a chunk of pending targets.
  const chunkRes = await admin
    .from("broadcast_send_targets")
    .select("id, customer_id, channel, status")
    .eq("send_job_id", job.id)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(CHUNK_SIZE);
  if (chunkRes.error) {
    attempt.blockedReason = chunkRes.error.message;
    await recordAttempt(chunkRes.error.message);
    return attempt;
  }
  const chunk = (chunkRes.data ?? []) as Array<{
    id: string;
    customer_id: string;
    channel: "sms" | "line" | "email";
    status: string;
  }>;

  // 5. Process each target.
  const dedupWindowHours = await getNumberFlag(
    FLAG_KEYS.BROADCAST_DEDUP_WINDOW_HOURS
  );
  const brand = resolveBrand(job.branch_id);

  for (const target of chunk) {
    attempt.processed += 1;

    // Channel master switch.
    const channelEnabled = await isChannelEnabled(target.channel);
    if (!channelEnabled) {
      await markSkipped(admin, target.id, `channel ${target.channel} disabled (feature flag)`);
      attempt.skipped += 1;
      continue;
    }

    // Communication policy (prefs + rate limit + recipient + per-
    // branch unsubscribe). branchId propagated for Phase 19's per-
    // branch opt-out check.
    const policy = await evaluatePolicy({
      customerId: target.customer_id,
      channel: target.channel,
      kind: "broadcast",
      intent: "promotional",
      branchId: job.branch_id,
    });
    if (!policy.ok) {
      await markSkipped(admin, target.id, `${policy.bucket}: ${policy.reason}`);
      attempt.skipped += 1;
      continue;
    }

    // Cross-draft dedup.
    const isDup = await isRecentlyBroadcasted({
      customerId: target.customer_id,
      windowHours: dedupWindowHours,
      currentJobId: job.id,
    });
    if (isDup) {
      await markSkipped(
        admin,
        target.id,
        `cross-draft dedup: another broadcast in last ${dedupWindowHours}h`
      );
      attempt.skipped += 1;
      continue;
    }

    // Dry-run mode: mark dispatched without enqueueing.
    if (job.mode === "dry_run") {
      await admin
        .from("broadcast_send_targets")
        .update({
          status: "dispatched",
          processed_at: new Date().toISOString(),
        })
        .eq("id", target.id)
        .eq("status", "pending");
      attempt.dispatched += 1;
      continue;
    }

    // Live mode: enqueue. Fetch customer recipient address.
    const recipient = await fetchRecipient(admin, target.customer_id, target.channel);
    if (!recipient) {
      await markSkipped(admin, target.id, "recipient address missing");
      attempt.skipped += 1;
      continue;
    }

    const body =
      target.channel === "sms"
        ? job.template_sms_snapshot
        : target.channel === "line"
          ? job.template_line_snapshot
          : null;
    if (!body || !body.trim()) {
      await markSkipped(admin, target.id, `template missing for ${target.channel}`);
      attempt.skipped += 1;
      continue;
    }

    const enq = await enqueueNotification({
      customerId: target.customer_id,
      branchId: job.branch_id,
      channel: target.channel,
      kind: "broadcast",
      payload: {
        broadcastJobId: job.id,
        body,
        ...(target.channel === "sms" ? { phone: recipient } : {}),
        ...(target.channel === "line" ? { lineUserId: recipient } : {}),
      },
      actorId,
    });
    if (!enq.ok) {
      await markSkipped(admin, target.id, enq.reason ?? "enqueue failed");
      attempt.skipped += 1;
      continue;
    }
    await admin
      .from("broadcast_send_targets")
      .update({
        status: "dispatched",
        notification_id: enq.notificationId,
        processed_at: new Date().toISOString(),
      })
      .eq("id", target.id)
      .eq("status", "pending");
    attempt.dispatched += 1;
  }

  // 6. Update metrics + check completion.
  await refreshMetricsForJob(admin, job, brand.shortLabel);
  await maybeMarkComplete(admin, job, actorId);

  // 7. Persist the tick log row.
  await recordAttempt(null);
  return attempt;
}

// ---------- Fan-out (first tick) ----------------------------------------

async function fanOutTargets(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  job: SendJob
): Promise<
  | { ok: true; expectedTotal: number }
  | { ok: false; reason: string }
> {
  // Compute the audience under operator-style "all branches" scope —
  // the segment definition itself + the job's branch_id provide
  // the actual scope. (RLS doesn't apply here because we're using
  // the service-role admin client.)
  const counts = await estimateAudience({
    segment: job.segment_snapshot,
    scope: {
      scopedBranchCodes: job.branch_id ? [job.branch_id] : null,
    },
  });

  // Per-job cap.
  const cap = await getNumberFlag(FLAG_KEYS.BROADCAST_MAX_TARGETS_PER_JOB);
  // The "expected targets" for the cap = total potential
  // (customers × channels). Reachable counts are slightly higher than
  // the strict reachable-after-prefs number but that's fine — the
  // cap is a "don't fan out a million rows" guard.
  const expectedTargets = counts.totalMatch * job.channels.length;
  if (expectedTargets > cap) {
    return {
      ok: false,
      reason: `audience ${expectedTargets} exceeds per-job cap ${cap}`,
    };
  }

  // We need the customer ID list. estimateAudience returns counts +
  // sample, not the full list. For now we re-fetch via the same
  // service. (Future: a streaming variant of estimateAudience.)
  const customerIds = await fetchCustomerIdsForSegment(
    admin,
    job.segment_snapshot,
    job.branch_id
  );
  if (customerIds.length === 0) {
    return { ok: true, expectedTotal: 0 };
  }

  // Insert one target per (customer × channel). Use UPSERT semantics
  // against the unique index so a retry after a partial fan-out
  // doesn't double-insert.
  const rows: Array<{
    send_job_id: string;
    customer_id: string;
    channel: string;
    status: string;
  }> = [];
  for (const cid of customerIds) {
    for (const ch of job.channels) {
      rows.push({
        send_job_id: job.id,
        customer_id: cid,
        channel: ch,
        status: "pending",
      });
    }
  }
  // Insert in chunks to avoid hitting Supabase / pg parameter limits.
  const INSERT_CHUNK = 500;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const slice = rows.slice(i, i + INSERT_CHUNK);
    const ins = await admin
      .from("broadcast_send_targets")
      .upsert(slice, {
        onConflict: "send_job_id,customer_id,channel",
        ignoreDuplicates: true,
      });
    if (ins.error) {
      return {
        ok: false,
        reason: `target insert failed at offset ${i}: ${ins.error.message}`,
      };
    }
  }
  return { ok: true, expectedTotal: rows.length };
}

async function fetchCustomerIdsForSegment(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  segment: SegmentDefinition,
  jobBranchId: string | null
): Promise<string[]> {
  // Lightweight, IDs-only fetch. Mirrors the filter logic in
  // crmSegmentationService — kept local rather than imported to keep
  // segmentation service's API focused on counts. Bumping the cap
  // here is safe; the audience-cap flag is the real ceiling.
  let q = admin.from("customers").select("id").limit(5000);

  if (jobBranchId) {
    q = q.eq("branch_id", jobBranchId);
  } else if (segment.branchSlugs && segment.branchSlugs.length > 0) {
    q = q.in("branch_id", segment.branchSlugs);
  }
  if (segment.tiers && segment.tiers.length > 0)
    q = q.in("customer_tier", segment.tiers);
  if (segment.lifecycleStages && segment.lifecycleStages.length > 0)
    q = q.in("lifecycle_stage", segment.lifecycleStages);
  if (segment.customerTypes && segment.customerTypes.length > 0)
    q = q.in("customer_type", segment.customerTypes);
  if (typeof segment.retentionScoreGte === "number")
    q = q.gte("retention_score", segment.retentionScoreGte);
  if (typeof segment.totalSpendGte === "number")
    q = q.gte("lifetime_spend", segment.totalSpendGte);
  if (typeof segment.totalOrdersGte === "number")
    q = q.gte("total_orders", segment.totalOrdersGte);
  if (typeof segment.inactiveDaysGte === "number" && segment.inactiveDaysGte > 0) {
    const cutoff = new Date(
      Date.now() - segment.inactiveDaysGte * 24 * 60 * 60 * 1000
    ).toISOString();
    q = q.lte("last_visit_at", cutoff);
  }
  if (typeof segment.activeWithinDays === "number" && segment.activeWithinDays > 0) {
    const cutoff = new Date(
      Date.now() - segment.activeWithinDays * 24 * 60 * 60 * 1000
    ).toISOString();
    q = q.gte("last_visit_at", cutoff);
  }
  if (segment.requirePhone) q = q.not("normalized_phone", "is", null);

  const res = await q;
  if (res.error || !res.data) return [];
  return ((res.data as Array<{ id: string }>) ?? []).map((r) => r.id);
}

// ---------- Per-target writers ------------------------------------------

async function markSkipped(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  targetId: string,
  reason: string
): Promise<void> {
  await admin
    .from("broadcast_send_targets")
    .update({
      status: "skipped",
      skip_reason: reason,
      processed_at: new Date().toISOString(),
    })
    .eq("id", targetId)
    .eq("status", "pending");
}

async function fetchRecipient(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  customerId: string,
  channel: "sms" | "line" | "email"
): Promise<string | null> {
  if (channel === "sms") {
    const { data } = await admin
      .from("customers")
      .select("normalized_phone, phone")
      .eq("id", customerId)
      .maybeSingle();
    if (!data) return null;
    const row = data as { normalized_phone: string | null; phone: string | null };
    return row.normalized_phone || row.phone || null;
  }
  if (channel === "line") {
    const { data } = await admin
      .from("customer_line_links")
      .select("line_user_id, unsubscribed_at")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    const row = data as { line_user_id: string; unsubscribed_at: string | null };
    if (row.unsubscribed_at) return null;
    return row.line_user_id;
  }
  return null;
}

// ---------- Metrics + completion ----------------------------------------

async function refreshMetricsForJob(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  job: SendJob,
  _brandLabel: string
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  // Compute per-channel counts from broadcast_send_targets. Cheap
  // for our sizes (≤ 2000 targets per job).
  for (const channel of job.channels) {
    const dispatchedRes = await admin
      .from("broadcast_send_targets")
      .select("id", { count: "exact", head: true })
      .eq("send_job_id", job.id)
      .eq("channel", channel)
      .eq("status", "dispatched");
    const skippedRes = await admin
      .from("broadcast_send_targets")
      .select("id", { count: "exact", head: true })
      .eq("send_job_id", job.id)
      .eq("channel", channel)
      .eq("status", "skipped");
    const dedupSkippedRes = await admin
      .from("broadcast_send_targets")
      .select("id", { count: "exact", head: true })
      .eq("send_job_id", job.id)
      .eq("channel", channel)
      .eq("status", "skipped")
      .like("skip_reason", "%dedup%");
    const optedOutRes = await admin
      .from("broadcast_send_targets")
      .select("id", { count: "exact", head: true })
      .eq("send_job_id", job.id)
      .eq("channel", channel)
      .eq("status", "skipped")
      .or("skip_reason.like.%channel_disabled%,skip_reason.like.%kind_opted_out%,skip_reason.like.%unsubscribed%");

    await admin.from("broadcast_metrics_daily").upsert(
      {
        send_job_id: job.id,
        metric_date: today,
        channel,
        queued_count: dispatchedRes.count ?? 0,
        sent_count: dispatchedRes.count ?? 0, // close enough; refined when worker writes 'sent'
        skipped_count: skippedRes.count ?? 0,
        deduped_count: dedupSkippedRes.count ?? 0,
        opted_out_count: optedOutRes.count ?? 0,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "send_job_id,metric_date,channel" }
    );
  }
}

async function maybeMarkComplete(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  job: SendJob,
  actorId: string | null
): Promise<void> {
  const pendingRes = await admin
    .from("broadcast_send_targets")
    .select("id", { count: "exact", head: true })
    .eq("send_job_id", job.id)
    .eq("status", "pending");
  if (pendingRes.error) return;
  if ((pendingRes.count ?? 0) > 0) return;

  // No pending rows → complete.
  await admin
    .from("broadcast_send_jobs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id)
    .eq("status", "processing");
  await admin.from("broadcast_audit_log").insert({
    draft_id: job.draft_id,
    action: "send_completed",
    actor_id: actorId,
    after_value: { send_job_id: job.id },
  });
}
