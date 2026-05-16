-- Phase 26 — Communication reliability completion.
--
-- One table: public.webhook_retry_queue.
--
-- A provider webhook that verifies + parses cleanly but then FAILS
-- during processing (a transient DB error, a downstream timeout) was,
-- until now, only recoverable by the provider's own retry — which we
-- do not control and which stops after a few attempts.
--
-- webhook_retry_queue gives the platform its OWN recovery path: the
-- failed call is captured as a normalized DeliveryReceipt (see
-- lib/deliveryReceipt.ts) and a dedicated cron re-applies it with
-- exponential backoff until it succeeds or is promoted to
-- dead_letter for operator attention.
--
-- The receipt is normalized + provider-agnostic, so a replay is
-- idempotent: applyDeliveryReceipt() only ever moves a notification
-- status forward.
--
-- All additive + idempotent.
--
-- ROLLBACK
--   drop table if exists public.webhook_retry_queue cascade;

begin;

create table if not exists public.webhook_retry_queue (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null
                     check (provider in ('twilio','resend','line')),
  /** Provider idempotency key — mirrors webhook_audit_log.event_id. */
  event_id           text,
  /** The normalized DeliveryReceipt — replaying it is provider-
   *  agnostic + idempotent. */
  receipt            jsonb not null default '{}'::jsonb,
  branch_id          text,
  status             text not null default 'pending'
                     check (status in (
                       'pending','retrying','succeeded','dead_letter'
                     )),
  attempts           integer not null default 0,
  max_attempts       integer not null default 6,
  /** When the retry cron may next pick this row up. */
  next_retry_at      timestamptz not null default now(),
  last_error         text,
  /** Set when status='dead_letter' — why we gave up. */
  terminal_reason    text,
  /** Operator audit — who manually replayed / resolved. */
  resolved_by        uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- The retry cron's hot path: due 'pending' rows, oldest first.
create index if not exists webhook_retry_queue_due_idx
  on public.webhook_retry_queue (next_retry_at)
  where status in ('pending','retrying');
create index if not exists webhook_retry_queue_status_idx
  on public.webhook_retry_queue (status, created_at desc);
create index if not exists webhook_retry_queue_provider_idx
  on public.webhook_retry_queue (provider, created_at desc);

create or replace function public.touch_webhook_retry_queue_updated()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists webhook_retry_queue_touch on public.webhook_retry_queue;
create trigger webhook_retry_queue_touch
  before update on public.webhook_retry_queue
  for each row execute procedure public.touch_webhook_retry_queue_updated();

alter table public.webhook_retry_queue enable row level security;

drop policy if exists webhook_retry_queue_admin_read on public.webhook_retry_queue;
create policy webhook_retry_queue_admin_read on public.webhook_retry_queue
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists webhook_retry_queue_branch_read on public.webhook_retry_queue;
create policy webhook_retry_queue_branch_read on public.webhook_retry_queue
  for select to authenticated
  using (
    public.current_user_role() = 'branch_manager'
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

commit;
