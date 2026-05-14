# CareU OPS Platform — CRM Broadcast Foundation

> **Status:** **send-capable** (Phase 16). Operators can build segments, estimate audiences, draft templates, AND **fan out real send jobs** with pause / resume / cancel + scheduling + cross-draft dedup + quiet-hours enforcement. Single-branch is the default; cross-branch sends require an explicit feature-flag flip.

---

## 1. Architecture

```
                       ┌───────────────────────────┐
                       │ /admin/crm/audiences      │
                       │ /admin/crm/broadcasts     │
                       │ /admin/crm/broadcasts/[id]│
                       └────────────┬──────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
            ▼                       ▼                       ▼
  /api/admin/crm/         /api/admin/crm/         /api/admin/crm/
  broadcasts (GET+POST)   broadcasts/[id]         audiences/estimate
                          (GET/PATCH/DELETE)      (POST)
            │                       │                       │
            └──────────────┬────────┴───────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
      broadcast_drafts        broadcast_audience_snapshots
      broadcast_audit_log
                           │
                           ▼
                  lib/crmSegmentationService
                  lib/communicationPolicyService
                           │
                           ▼
                   customers + prefs + line_links
```

The drafts API is the persistence layer. The segmentation service is the compute layer. The communication policy service is the *future* gate — it will sit between the broadcast send code (deferred phase) and the dispatch worker.

---

## 2. Tables (migration `20260539`)

| Table | Purpose |
|---|---|
| `broadcast_drafts` | One row per draft. `status` ∈ {draft, preview, archived}. No 'sent' state in Phase 15. |
| `broadcast_audience_snapshots` | Cached estimate per draft, keyed by computed_at. Stored as JSONB distribution + scalar counts. |
| `broadcast_audit_log` | Append-only audit of every state-changing draft action. |
| `line_delivery_log` | Sibling to `notification_dispatch_log`, specifically for LINE-side events: push receipt, unfollow, block. |

RLS: owner / hq_admin have full access; branch_manager has scoped read+write on drafts within their own branch. Front_staff and technician are denied across the board.

---

## 3. Segment definition

`SegmentDefinition` (TypeScript) maps to the JSONB stored in `broadcast_drafts.segment`. All filters AND-combine; filters left null/empty don't constrain.

| Field | Type | What |
|---|---|---|
| `branchSlugs` | string[] | match `customers.branch_id IN (...)` |
| `tiers` | string[] | `customer_tier IN (...)` |
| `lifecycleStages` | string[] | `lifecycle_stage IN (...)` |
| `customerTypes` | string[] | `customer_type IN (...)` |
| `retentionScoreGte` | number | `retention_score >= N` |
| `totalSpendGte` | number | `lifetime_spend >= N` (Baht) |
| `totalOrdersGte` | number | `total_orders >= N` |
| `inactiveDaysGte` | number | `last_visit_at <= now() - N days` |
| `activeWithinDays` | number | `last_visit_at >= now() - N days` |
| `requireLineLink` | boolean | has an active customer_line_links row |
| `requirePhone` | boolean | has normalized_phone |

The segmentation service caps the customer fetch at 5000 rows — beyond that the segment is considered "too wide" and the operator needs to narrow before sending.

---

## 4. Audience estimation

`POST /api/admin/crm/audiences/estimate` computes:

- `totalMatch` — pre-preference customer count.
- `reachableLine` / `reachableSms` / `reachableEmail` — counts after applying preferences + channel presence (phone for SMS, LINE link for LINE).
- `optedOut*` — counts where preferences would block delivery.
- `distribution.byBranch` / `byTier` / `byStage` — Pareto-style facets the UI renders as horizontal bars.
- `estimatedCostThb` — `reachableSms * PROVIDER_SMS_COST_THB` (default 0.45 THB/segment).

Phase 15 treats ALL broadcasts as **promotional** for opt-in purposes. The lifecycle notifier already handles transactional sends; broadcasts must therefore go to customers who explicitly turned `promotional` ON in `/portal/preferences`. Default is OFF — Thai opt-in norms.

Estimation is rate-limited 20/10min/IP. When linked to a draft, the response writes a `broadcast_audience_snapshots` row + flips the draft's status from `draft` to `preview`.

---

## 5. Communication Policy Service

`lib/communicationPolicyService.ts::evaluatePolicy` is the single authoritative gate. Order of checks (cheapest first):

1. **Channel master toggle** — did the customer turn this channel off in preferences?
2. **Kind toggle** — is `promotional` / `pickup_reminders` / etc. allowed for this kind?
3. **Recipient presence** — phone for SMS, LINE link for LINE.
4. **Per-customer rate limit** — defers to `lib/customerRateLimit.ts`.

OTP / identity-critical messages bypass all of the above (`intent === 'transactional' && kind === 'otp'`).

The existing lifecycle notifier and dispatch worker continue to run their inline checks. The policy service is the new authoritative reference; new code paths (broadcast send, when it lands) MUST call it instead of reinventing the logic.

---

## 6. HEIC real transcoder

`lib/heicTranscoder.ts::transcodeHeicToJpeg`:

- Uses `sharp` (libheif build). Decodes HEIC/HEIF, applies EXIF orientation via `.rotate()` (no arg), re-encodes to mozjpeg @ quality 82.
- Writes the JPEG output to `<sourcePath>.jpg`.
- Generates a thumbnail capped at 320 px to `<sourcePath>.thumb.jpg`. Thumbnail failures don't fail the main transcode.
- Strips PII metadata (EXIF GPS / camera serial) by NOT carrying forward the EXIF profile.

The cron route `/api/cron/heic-transcode` calls this for every pending row. `HEIC_TRANSCODER` env values:

- (unset) / `enabled` — real transcoder runs (default).
- `stub` — leave pending rows untouched (manual debug mode).
- `disabled` — dead-letter all pending rows (feature shut-off).

libheif availability: sharp's official prebuilt binaries ship libheif on Linux x64, Linux ARM, and macOS. Windows prebuilt does NOT — a Windows dev sees `HEIF decode unavailable: ...` and the row stays pending (retryable). Production on Linux always succeeds.

---

## 7. LINE delivery log

`public.line_delivery_log` is the LINE-side analogue of `notification_dispatch_log`. We write to it from two sources:

| Source | Events |
|---|---|
| Dispatch worker `dispatchLine` | `pushed` (HTTP 200 from LINE API) / `push_failed` (4xx / 5xx) |
| LINE webhook `processLineWebhookBody` | `unfollowed` (user unfollowed the channel) |

We DO NOT pretend we have delivery confirmations LINE doesn't give us. The Messaging API only acks the push; there's no "user read it" callback. Our current "delivered" inference for LINE is: push 200 + no observed unfollow at receive time.

Admin customer view (`/admin/customers/[id]`) renders the most recent 15 rows so operators can answer "did our LINE pushes ever reach this customer?".

---

## 8. UI surfaces

| URL | What |
|---|---|
| `/admin/crm/audiences` | Standalone segment builder — iterate without saving. Shows counts + distribution + sample customers. |
| `/admin/crm/broadcasts` | Draft list. Each card shows status, channels, branch, last touched. |
| `/admin/crm/broadcasts/[id]` | Draft editor. Name, notes, channels, segment, templates per channel. "ประมาณการ audience" button computes + caches a snapshot. The "ส่ง broadcast" button is intentionally disabled — Phase 15 contract. |

A card-style entry on `/admin` links to each.

---

## 9. Branch isolation

| Surface | Auth | Scope |
|---|---|---|
| `/api/admin/crm/broadcasts` (list+create) | owner / hq_admin / branch_manager | branch_manager sees only own-branch drafts; create forces branch_id=own |
| `/api/admin/crm/broadcasts/[id]` (read/update/archive) | same | `requireBranchAccess(draft.branch_id)` |
| `/api/admin/crm/audiences/estimate` | same | scopedBranchCodes from `requireRole` narrows the customer pool |
| `lib/crmSegmentationService` | server-only | accepts `scopedBranchCodes` from caller; refuses cross-branch customers |

A branch_manager who knows another branch's draft id cannot read it — the API responds 403.

---

## 10. Send pipeline (Phase 16)

The Phase 15 drafts now produce real broadcasts.

### 10.1 Schema (migration `20260540`)

| Table | Purpose |
|---|---|
| `broadcast_send_jobs` | one row per "send this draft" action. Snapshots segment + templates so a later draft edit doesn't change what was sent. status ∈ {queued, processing, paused, completed, cancelled, failed}. `mode ∈ {live, dry_run}`. |
| `broadcast_send_targets` | one row per (job, customer, channel). Unique on the triple — re-running fan-out can't double-insert. |
| `broadcast_send_attempts` | append-only log of each cron tick that processed a job. |
| `broadcast_metrics_daily` | per (job, channel, date) aggregated counts. |
| `feature_flags` | server-side toggle service. Hard-coded fallbacks match the DB defaults. |

### 10.2 Pipeline flow

```
operator clicks "ส่งตอนนี้" /admin/crm/broadcasts/[id]
            │
            ▼
POST /api/admin/crm/broadcasts/[id]/send
   ├─ requireRole + requireBranchAccess
   ├─ channel flags + cross-branch flag check
   ├─ checkAudienceCap (broadcast_max_targets_per_job)
   └─ INSERT broadcast_send_jobs status=queued
                │
                ▼
        cron /api/cron/broadcast-send
        (Bearer CRON_SECRET, every minute)
                │
                ▼
        runBroadcastSendTick()
        ├─ checkSchedule           (scheduled_for ≤ now?)
        ├─ checkQuietHours         (09:00–19:00 Bangkok?)
        ├─ first run → fan-out targets
        │   ├─ fetch customer ids matching segment
        │   └─ INSERT one target per (customer × channel)
        ├─ CHUNK_SIZE=50 per tick
        │   ├─ isChannelEnabled         (feature flag)
        │   ├─ evaluatePolicy           (prefs + rate limit)
        │   ├─ isRecentlyBroadcasted    (cross-draft dedup window)
        │   └─ enqueueNotification + mark target dispatched
        ├─ refresh broadcast_metrics_daily
        └─ no pending rows → status=completed
```

The existing dispatch worker drains the resulting `customer_notifications` rows. The broadcast worker only owns the **fan-out**, not the actual provider send — reuse is intentional.

### 10.3 Feature flags

| Key | Default | Purpose |
|---|---|---|
| `enable_sms` | true | SMS broadcast channel master |
| `enable_line_broadcast` | true | LINE broadcast channel master |
| `enable_scheduled_broadcasts` | true | allow scheduled jobs |
| `enable_cross_branch_broadcasts` | **false** | when off, audiences must restrict to one branch |
| `broadcast_max_targets_per_job` | 2000 | hard cap; refuses oversized fan-outs at queue time |
| `broadcast_quiet_hours_start_h` | 9 | Bangkok hour-of-day allowed start |
| `broadcast_quiet_hours_end_h` | 19 | Bangkok hour-of-day allowed end (exclusive) |
| `broadcast_dedup_window_hours` | 24 | "skip if customer received another broadcast in last N hours" |

Owner / hq_admin can edit values; everyone else reads. Branch-scoped overrides supported (rows with `branch_id` non-null). Cached in-process for 60 s.

### 10.4 Quiet hours

Worker calls `checkQuietHours()` at the top of every tick. Outside 09:00–19:00 Bangkok the tick records a `broadcast_send_attempts` row with `blocked_reason="outside Bangkok quiet hours window …"` and processes nothing. A job that should have completed last night resumes seamlessly at 09:01 — the cron just hits the gate again and continues. Bangkok timezone resolved via `Intl.DateTimeFormat({ timeZone: "Asia/Bangkok" })`; fallback adds UTC+7 if the runtime lacks tz data.

### 10.5 Cross-draft dedup

`isRecentlyBroadcasted(opts)` looks at `broadcast_send_targets` for rows older than `windowHours` with status='dispatched' for the same customer, excluding the current job. Hits mark the new target `skipped` with reason `cross-draft dedup: another broadcast in last Nh`. "Newest send wins" is the natural outcome — when a fresher job runs first, the older job sees a recently-dispatched row and skips. When jobs run in parallel, the broadcast_send_targets unique index plus the optimistic-concurrency update prevent any single customer from getting two broadcasts at the same instant.

### 10.6 Pause / resume / cancel

```
PATCH /api/admin/crm/broadcasts/[id]/jobs/[jobId]
      { action: "pause" | "resume" | "cancel", reason?: string }
```

State transitions enforced:

| from \ to | pause | resume | cancel |
|---|---|---|---|
| queued | ✅ | — | ✅ |
| processing | ✅ | — | ✅ |
| paused | — | ✅ → processing | ✅ |
| completed | — | — | — |
| cancelled | — | — | — |
| failed | — | — | — |

Cancelling a job also sets every still-`pending` target to `skipped` with reason `job cancelled by operator`. Already-dispatched notifications are NOT recalled — they're sitting in `customer_notifications` and may have left the provider. The operator can use `/api/admin/notifications/cancel` for individual queue rows that haven't sent yet.

### 10.7 Dry-run mode

`mode: 'dry_run'` on the send call creates a full job with all the targets, runs them through the policy + dedup gates, and marks them `dispatched`/`skipped` **without enqueueing notifications**. The metrics daily table fills in normally. Use this to validate the audience before spending provider quota — "what would happen if I sent this right now?".

### 10.8 Monitoring UI

`/admin/crm/broadcasts/[id]/jobs/[jobId]` — per-job dashboard:

- Status pill + progress bar (`dispatched + skipped + dead_letter` / `expected_total`).
- 4 KPI cards: Dispatched / Pending / Skipped / Dead-letter.
- Channel breakdown (per-channel dispatched / skipped / pending).
- 20 most recent fan-out ticks with duration + blocked reasons.
- 20 most recently processed targets (customer id + channel + skip reason).
- Pause / Resume / Cancel / Refresh buttons gated by status.
- Visibility-aware polling: 8 s while `processing`, 20 s while queued/paused, 60 s once terminal.

`/admin/dispatch` now also shows a Broadcast health panel with "active jobs / completed 24h / cancelled 24h / failed 24h" + a list of in-flight jobs.

### 10.9 Audit trail additions

`broadcast_audit_log.action` enum extended:
- `send_queued` — operator clicked send.
- `send_started` — first fan-out tick after target creation.
- `send_paused` / `send_resumed` / `send_cancelled` — operator actions.
- `send_completed` — automatic when last target is processed.
- `send_failed` — auto on fan-out fatal error (e.g. flag flipped mid-flight).

Every row carries `actor_id`, `reason`, `request_ip`. The dispatch / customer activity feeds also pick up notification-level events (`notification_delivered` / `notification_failed`) per Phase 14.

### 10.10 Cron schedule

| Endpoint | Recommended interval |
|---|---|
| `/api/cron/dispatch-worker` | 1 min |
| `/api/cron/broadcast-send` | 1 min |
| `/api/cron/retry-worker` | 5 min |
| `/api/cron/overdue-pickup-sweep` | daily (mid-day) |
| `/api/cron/heic-transcode` | 10 min |

The broadcast-send cron is the most frequent — a 1-minute cadence on a `CHUNK_SIZE=50` worker gives an effective send rate of ~3000 targets/hour per job, well within Twilio + LINE rate limits.

---

## 11. Known limitations

- **No A/B testing / variant templates** — drafts hold one template per channel.
- **No customer-priority routing** — first-come-first-served within a job's segment. A "VIP customers first" pass would require sorting by tier on the fan-out fetch.
- **Segmentation caps at 5000 customers** — broader audiences must be narrowed.
- **LINE "delivered" is inferred** — no per-message delivery callback exists.
- **HEIC transcoder requires libheif-enabled sharp** — Linux/macOS prebuilt OK; Windows dev sees a known retryable error.
- **Cancellation doesn't recall sent SMS/LINE** — by design; the provider has already accepted the message.
- **No cross-tick dedup within one job** — the unique index on `(send_job_id, customer_id, channel)` prevents same-job duplicates, but the operator can in theory create two jobs against the same draft; cross-draft dedup catches that within the 24 h window.
- **Quiet hours are global** — the same 09:00–19:00 Bangkok window applies to every branch. Per-branch overrides are supported by the `feature_flags.branch_id` column but not yet exposed in UI.
- **No partial-resume semantics for `failed` jobs** — a `failed` job stays failed; operator's recovery path is to clone the draft and resend. Manual SQL update can flip status back to `processing` if needed.

---

**Last updated:** 2026-05-14 (phase 16 — broadcast send pipeline + scheduling + dedup + monitoring)
