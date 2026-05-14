-- Broadcast foundation + LINE delivery log + segmentation snapshot
-- support.
--
-- Phase 15 deliverables, schema side:
--
--   1. public.line_delivery_log — companion to notification_dispatch_log
--      specifically for the LINE-side delivery confirmations we can
--      capture (LINE doesn't ship a Twilio-style status webhook; we
--      record what we do get: push receipts + webhook follow/unfollow
--      events relevant to delivery health).
--
--   2. public.broadcast_drafts — draft-only campaign rows. PHASE 15
--      INTENTIONALLY DOES NOT MASS-SEND. Drafts hold a template, a
--      target segment definition (JSONB), a status that maxes out at
--      'preview'. Operators can iterate and estimate, no recipients
--      actually receive anything.
--
--   3. public.broadcast_audience_snapshots — point-in-time computed
--      audience for a draft. Estimating the audience is expensive
--      (scans customers + preferences + line_links + recent
--      notifications); snapshots cache the result so the preview UI
--      doesn't recompute on every refresh.
--
--   4. public.broadcast_audit_log — every state change on a draft.
--
-- All tables RLS-protected. Service-role admin client writes; the
-- /admin/crm/* UI reads via the API which enforces role + branch
-- scope. No customer-facing surface.
--
-- ROLLBACK
--   drop table if exists public.broadcast_audit_log         cascade;
--   drop table if exists public.broadcast_audience_snapshots cascade;
--   drop table if exists public.broadcast_drafts            cascade;
--   drop table if exists public.line_delivery_log           cascade;

create extension if not exists "pgcrypto";

-- ---------- 1. line_delivery_log -----------------------------------------
--
-- One row per LINE delivery event we can observe. Sources:
--   • Dispatch worker push: synthetic 'pushed' or 'push_failed' row
--     written from lib/lineDeliveryTracker.ts when pushTextMessage
--     returns.
--   • LINE webhook: any verified event whose lineUserId we can match
--     to a customer — captures unfollow / block / spam events that
--     effectively kill delivery for that user.
--
-- We DO NOT pretend we have delivery confirmations LINE doesn't give
-- us. The Messaging API's push response is a 200/4xx ack only — there
-- is no "the user read it" callback. Our 'delivered' state for LINE
-- is currently inferred (push 200 + user not blocked / unsubscribed).

create table if not exists public.line_delivery_log (
  id                  uuid primary key default gen_random_uuid(),
  notification_id     uuid references public.customer_notifications(id) on delete set null,
  customer_id         uuid references public.customers(id) on delete set null,
  branch_id           text,
  line_user_id        text,
  /** 'pushed' — provider 200 ack
   *  'push_failed' — provider 4xx/5xx
   *  'unfollowed' — webhook captured unfollow
   *  'blocked' — webhook captured block / spam-report
   *  'unsubscribed' — operator-driven, future
   *  'expired' — push not attempted because the link is too old */
  event_type          text not null check (event_type in (
    'pushed','push_failed','unfollowed','blocked','unsubscribed','expired'
  )),
  request_id          text,
  http_status         integer,
  reason              text,
  details             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists line_delivery_log_created_idx
  on public.line_delivery_log (created_at desc);
create index if not exists line_delivery_log_notification_idx
  on public.line_delivery_log (notification_id);
create index if not exists line_delivery_log_customer_idx
  on public.line_delivery_log (customer_id, created_at desc)
  where customer_id is not null;
create index if not exists line_delivery_log_user_idx
  on public.line_delivery_log (line_user_id);

alter table public.line_delivery_log enable row level security;

drop policy if exists line_delivery_log_admin_read on public.line_delivery_log;
create policy line_delivery_log_admin_read on public.line_delivery_log
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists line_delivery_log_branch_read on public.line_delivery_log;
create policy line_delivery_log_branch_read on public.line_delivery_log
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 2. broadcast_drafts ------------------------------------------
--
-- A draft has:
--   • A name + free-form notes.
--   • A target SEGMENT definition (JSONB) — the structured filter the
--     segmentation service compiles to a customer set. Stored as JSONB
--     for forward-compat — new filter fields don't need a migration.
--   • A MESSAGE template per channel — operator can pre-write the
--     LINE-shaped vs the SMS-shaped body.
--   • A status: 'draft' (editing) / 'preview' (audience estimated)
--     / 'archived' (kept for audit, no longer editable).
--   • NEVER 'sent' — sending UI is deferred to a later phase.

create table if not exists public.broadcast_drafts (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  notes               text,
  /** Segment definition. See lib/crmSegmentationService.ts for the
   *  expected shape. Example:
   *    { "branchSlugs": ["c24-thonburi-market"],
   *      "tiers": ["gold","platinum"],
   *      "lifecycleStages": ["active"],
   *      "inactiveDaysGte": null,
   *      "totalSpendGte": 1000 } */
  segment             jsonb not null default '{}'::jsonb,
  /** Per-channel template bodies — null when this draft doesn't
   *  target that channel. */
  template_sms        text,
  template_line       text,
  /** Which channels this draft would dispatch to if/when sending
   *  was enabled. Stored explicitly so audience estimation can
   *  intersect with per-channel opt-in. */
  channels            text[] not null default '{}',
  status              text not null default 'draft'
                      check (status in ('draft','preview','archived')),
  /** Branch scope of the draft — when non-null, branch_manager /
   *  front_staff can edit drafts in their own branch. Owner / HQ
   *  can edit anything regardless of branch_id. */
  branch_id           text,
  created_by          uuid,
  updated_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists broadcast_drafts_status_idx
  on public.broadcast_drafts (status, updated_at desc);
create index if not exists broadcast_drafts_branch_idx
  on public.broadcast_drafts (branch_id) where branch_id is not null;

create or replace function public.touch_broadcast_drafts_updated() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists broadcast_drafts_touch on public.broadcast_drafts;
create trigger broadcast_drafts_touch
  before update on public.broadcast_drafts
  for each row execute procedure public.touch_broadcast_drafts_updated();

alter table public.broadcast_drafts enable row level security;

drop policy if exists broadcast_drafts_admin_full on public.broadcast_drafts;
create policy broadcast_drafts_admin_full on public.broadcast_drafts
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists broadcast_drafts_branch_rw on public.broadcast_drafts;
create policy broadcast_drafts_branch_rw on public.broadcast_drafts
  for all to authenticated
  using (
    public.current_user_role() in ('branch_manager')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  )
  with check (
    public.current_user_role() = 'branch_manager'
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 3. broadcast_audience_snapshots ------------------------------
--
-- Cached estimate of "who would this draft reach right now?". Computed
-- by /api/admin/crm/audiences/estimate; the API caches the result so
-- the preview UI doesn't recompute on every refresh. Caller can pass
-- force=true to recompute.
--
-- One row per (draft, computed_at) — keep history for forensics. The
-- UI shows the latest row per draft.

create table if not exists public.broadcast_audience_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  draft_id            uuid not null references public.broadcast_drafts(id) on delete cascade,
  /** Total customers matching the segment, regardless of opt-in. */
  total_match         integer not null default 0,
  /** Reachable counts after applying preferences + channel-link
   *  presence. */
  reachable_line      integer not null default 0,
  reachable_sms       integer not null default 0,
  reachable_email     integer not null default 0,
  /** Opt-out counts at each layer. */
  opted_out_line      integer not null default 0,
  opted_out_sms       integer not null default 0,
  opted_out_email     integer not null default 0,
  /** Distribution slices — JSONB so we can add facets without a
   *  migration each time. Example:
   *    { "byBranch": {"c24-thonburi-market": 32, "ezy-repair-saladaeng": 18},
   *      "byTier":   {"gold": 12, "platinum": 4},
   *      "byStage":  {"active": 38, "at_risk": 8} } */
  distribution        jsonb not null default '{}'::jsonb,
  /** Rough cost projection for the campaign. SMS uses a per-segment
   *  estimate (PROVIDER_SMS_COST_THB env or default 0.45 THB/segment);
   *  LINE pushes are zero-marginal-cost in most LINE plans. */
  estimated_cost_thb  numeric(12, 2) not null default 0,
  /** Estimation metadata. */
  computed_by         uuid,
  computed_at         timestamptz not null default now()
);

create index if not exists broadcast_audience_snapshots_draft_idx
  on public.broadcast_audience_snapshots (draft_id, computed_at desc);

alter table public.broadcast_audience_snapshots enable row level security;

drop policy if exists broadcast_audience_snapshots_admin_read
  on public.broadcast_audience_snapshots;
create policy broadcast_audience_snapshots_admin_read
  on public.broadcast_audience_snapshots
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists broadcast_audience_snapshots_branch_read
  on public.broadcast_audience_snapshots;
create policy broadcast_audience_snapshots_branch_read
  on public.broadcast_audience_snapshots
  for select to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and exists (
      select 1 from public.broadcast_drafts d
      where d.id = broadcast_audience_snapshots.draft_id
        and (d.branch_id is null or d.branch_id = public.current_user_branch_code())
    )
  );

-- ---------- 4. broadcast_audit_log ---------------------------------------
--
-- Every state-changing draft action. Phase 15 sees: create, update,
-- archive, estimate. Future send-related actions will land here too.

create table if not exists public.broadcast_audit_log (
  id            uuid primary key default gen_random_uuid(),
  draft_id      uuid references public.broadcast_drafts(id) on delete set null,
  action        text not null check (action in (
    'create','update','archive','restore','estimate'
  )),
  actor_id      uuid,
  before_value  jsonb,
  after_value   jsonb,
  reason        text,
  request_ip    text,
  created_at    timestamptz not null default now()
);

create index if not exists broadcast_audit_log_draft_idx
  on public.broadcast_audit_log (draft_id, created_at desc);
create index if not exists broadcast_audit_log_actor_idx
  on public.broadcast_audit_log (actor_id, created_at desc)
  where actor_id is not null;

alter table public.broadcast_audit_log enable row level security;

drop policy if exists broadcast_audit_log_admin_read on public.broadcast_audit_log;
create policy broadcast_audit_log_admin_read on public.broadcast_audit_log
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- ============================================================================
-- Verification queries:
--
--   select count(*) from public.line_delivery_log;             -- 0
--   select count(*) from public.broadcast_drafts;              -- 0
--   select count(*) from public.broadcast_audience_snapshots;  -- 0
--   select count(*) from public.broadcast_audit_log;           -- 0
--
-- ============================================================================
