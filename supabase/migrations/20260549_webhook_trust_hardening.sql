-- Phase 25 — Trustworthiness hardening.
--
-- Two tables that turn observability from "works" into "provably
-- reliable":
--
--   1. public.webhook_audit_log — one row per inbound provider
--      webhook call (Twilio / Resend / LINE). Records the signature
--      verdict + the processing outcome. Powers:
--        • replay protection — a unique index on (provider, event_id)
--          for accepted rows means a re-delivered callback is
--          detected, not reprocessed;
--        • invalid-signature + callback-failure metrics;
--        • a provider-payload audit trail for incident export.
--
--   2. public.escalation_recipients — dedicated, role-tiered alert
--      recipients (owner / hq_admin / branch_manager / technician_lead)
--      with severity routing, branch-aware scoping, and a temporary
--      mute window. Richer than alert_preferences.recipients[]
--      (which stays as the simple/global fallback).
--
-- All additive + idempotent.
--
-- ROLLBACK
--   drop table if exists public.webhook_audit_log     cascade;
--   drop table if exists public.escalation_recipients cascade;

begin;

-- ---------- 1. webhook_audit_log ----------------------------------------

create table if not exists public.webhook_audit_log (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null
                    check (provider in ('twilio','resend','line')),
  /** Provider-stable idempotency key. Twilio: '<sid>:<status>'.
   *  Resend: the Svix 'svix-id' header. LINE: webhookEventId / body
   *  hash. */
  event_id          text,
  signature_valid   boolean not null default false,
  /** accepted          — verified + processed.
   *  invalid_signature — HMAC check failed.
   *  replay            — already-accepted event_id seen again.
   *  malformed         — body could not be parsed.
   *  error             — handler threw while processing. */
  outcome           text not null
                    check (outcome in (
                      'accepted','invalid_signature','replay',
                      'malformed','error'
                    )),
  branch_id         text,
  /** Latency from provider timestamp → our receipt, when derivable. */
  callback_latency_ms integer,
  detail            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

-- Replay protection: at most one ACCEPTED row per (provider, event_id).
create unique index if not exists webhook_audit_log_accepted_unique
  on public.webhook_audit_log (provider, event_id)
  where outcome = 'accepted' and event_id is not null;

create index if not exists webhook_audit_log_provider_time_idx
  on public.webhook_audit_log (provider, created_at desc);
create index if not exists webhook_audit_log_outcome_idx
  on public.webhook_audit_log (outcome, created_at desc)
  where outcome <> 'accepted';

alter table public.webhook_audit_log enable row level security;

drop policy if exists webhook_audit_log_admin_read on public.webhook_audit_log;
create policy webhook_audit_log_admin_read on public.webhook_audit_log
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- ---------- 2. escalation_recipients ------------------------------------

create table if not exists public.escalation_recipients (
  id                uuid primary key default gen_random_uuid(),
  /** Which rung of the escalation ladder this recipient sits on.
   *  Not a platform auth role — a routing category. */
  role_tier         text not null
                    check (role_tier in (
                      'owner','hq_admin','branch_manager','technician_lead'
                    )),
  /** null = applies to every branch; a code = branch-scoped. */
  branch_id         text,
  /** A human label for the admin UI. */
  label             text,
  email             text,
  /** LINE user / group / room id for this recipient. */
  line_target       text,
  /** Lowest severity this recipient wants. 'warning' = everything. */
  min_severity      text not null default 'warning'
                    check (min_severity in ('warning','critical')),
  /** When set + in the future, this recipient is temporarily muted. */
  muted_until       timestamptz,
  enabled           boolean not null default true,
  updated_at        timestamptz not null default now(),
  updated_by        uuid,
  created_at        timestamptz not null default now()
);

create index if not exists escalation_recipients_tier_idx
  on public.escalation_recipients (role_tier, enabled);
create index if not exists escalation_recipients_branch_idx
  on public.escalation_recipients (branch_id) where branch_id is not null;

alter table public.escalation_recipients enable row level security;

drop policy if exists escalation_recipients_admin_all on public.escalation_recipients;
create policy escalation_recipients_admin_all on public.escalation_recipients
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

commit;
