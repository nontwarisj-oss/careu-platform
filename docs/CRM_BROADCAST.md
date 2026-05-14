# CareU OPS Platform — CRM Broadcast Foundation

> **Status:** **draft-only**. Operators can build segments, estimate audience sizes, draft templates, and preview cost. Mass-send is intentionally NOT enabled — the dispatch path stays out of scope until a later phase. The infrastructure (drafts, segmentation, policy service) is ready for it.

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

## 10. Known limitations

- **No mass-send pipeline.** By design — Phase 15 builds the foundation only. The send code will be a separate module that consumes `evaluatePolicy` + the dispatch worker.
- **No A/B testing / variant templates** — drafts hold one template per channel.
- **No scheduling** — drafts have no `send_at`. When sending is added it'll need scheduling + windows.
- **No deduplication across drafts** — if two drafts target overlapping audiences, a customer would in principle receive both. Will need cross-draft dedup at the policy level when sending lands.
- **Segmentation caps at 5000 customers** to protect the API. Wider segments need a streaming / pagination strategy.
- **LINE "delivered" is inferred, not confirmed.** The Messaging API doesn't expose a per-message delivery callback. We capture pushes + unfollows; "delivered" status on `customer_notifications` is set by the worker on 200 ack and remains there unless an unfollow happens.
- **HEIC transcoder requires libheif-enabled sharp.** Linux/macOS prebuilt binaries include it; Windows does not. A Windows dev machine logs a clean "HEIF decode unavailable" reason and the row stays pending until the next run on a real environment.

---

**Last updated:** 2026-05-14 (phase 15 — broadcast foundation + segmentation + real HEIC transcoder)
