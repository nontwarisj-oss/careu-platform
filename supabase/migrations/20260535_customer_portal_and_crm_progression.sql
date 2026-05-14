-- Customer portal + CRM progression.
--
-- Three sets of changes ship together:
--
--   1. Customer-side auth scaffolding — public.customer_otp_codes for
--      the (foundation-phase) phone+OTP sign-in flow. The OTP code is
--      stored as a salted hash; the cookie is HMAC-signed (codec in
--      lib/customerSession.ts). No SMS gateway today — codes are emitted
--      via console.info; dev/test accepts the universal code "123456".
--
--   2. CRM progression columns on public.customers — lifecycle_stage,
--      retention_score. The existing total_orders / lifetime_spend /
--      last_visit_at columns from `20260531` already cover spend and
--      visit recency; this phase adds the stage + score the future
--      automation reads.
--
--   3. public.customer_notifications — outbound queue for the future
--      broadcast / reminder engine. This phase writes log-only rows;
--      a worker that dispatches them is intentionally not built.
--
-- Also: a private Supabase Storage bucket `customer-uploads` is created
-- so signed-URL uploads work out of the box. Storage RLS is intentionally
-- closed by default — every upload flows through our /api routes that
-- issue signed URLs via the service-role admin client.
--
-- ROLLBACK
--   drop table if exists public.customer_notifications cascade;
--   drop table if exists public.customer_otp_codes cascade;
--   alter table public.customers
--     drop column if exists lifecycle_stage,
--     drop column if exists retention_score;
--   delete from storage.buckets where id = 'customer-uploads';

create extension if not exists "pgcrypto";

-- ---------- 1. customer_otp_codes ----------------------------------------
--
-- One row per OTP request. Anti-replay via `consumed_at`; expiry via
-- `expires_at`. We keep historical rows (no auto-purge) so admins can
-- audit failed attempts.

create table if not exists public.customer_otp_codes (
  id            uuid primary key default gen_random_uuid(),
  /** Normalised phone number — matches public.customers.normalized_phone. */
  phone         text not null,
  /** SHA-256(salt || code). Salt is the row id itself; never store
   *  plaintext. */
  code_hash     text not null,
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  attempts      integer not null default 0,
  /** Free-form context — IP, UA hash, etc. */
  request_meta  jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists customer_otp_codes_phone_idx
  on public.customer_otp_codes (phone, created_at desc);
create index if not exists customer_otp_codes_pending_idx
  on public.customer_otp_codes (phone, expires_at)
  where consumed_at is null;

alter table public.customer_otp_codes enable row level security;

-- Only owner / hq_admin can read — useful for incident review. Writes go
-- through the service-role admin client from /api/portal/auth/* routes.
drop policy if exists customer_otp_codes_admin_read on public.customer_otp_codes;
create policy customer_otp_codes_admin_read on public.customer_otp_codes
  for select to authenticated
  using (public.current_user_role() in ('owner','hq_admin'));

-- ---------- 2. CRM progression columns ----------------------------------

alter table public.customers
  add column if not exists lifecycle_stage text
    check (lifecycle_stage in ('new','active','at_risk','dormant','reactivated','churned'));
alter table public.customers
  add column if not exists retention_score numeric(5, 2);

comment on column public.customers.lifecycle_stage is
  'Computed by lib/crmProgressionService.ts. Source of truth for segmentation queries.';
comment on column public.customers.retention_score is
  '0–100 score derived from recency + frequency + spend. Computed alongside lifecycle_stage.';

create index if not exists customers_lifecycle_idx
  on public.customers (lifecycle_stage) where lifecycle_stage is not null;
create index if not exists customers_retention_idx
  on public.customers (retention_score desc) where retention_score is not null;

-- ---------- 3. customer_notifications ------------------------------------
--
-- Outbound queue. Foundation phase writes here and stops — a future worker
-- reads pending rows and dispatches via lib/lineMessaging / future email
-- + SMS clients.

create table if not exists public.customer_notifications (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references public.customers(id) on delete set null,
  branch_id     text,
  /** Delivery channel. SMS is reserved for a future provider. */
  channel       text not null check (channel in ('line','email','in_app','sms')),
  /** Free-form event identifier — 'order_ready', 'pickup_reminder',
   *  'welcome', etc. The dispatcher routes on this. */
  kind          text not null,
  /** Renderer / template input. Keep PII out of indexes by holding it
   *  in jsonb rather than columns. */
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'queued'
                check (status in ('queued','sending','sent','failed','skipped')),
  error_reason  text,
  send_after    timestamptz not null default now(),
  sent_at       timestamptz,
  attempts      integer not null default 0,
  created_at    timestamptz not null default now(),
  created_by    uuid
);

create index if not exists customer_notifications_pending_idx
  on public.customer_notifications (status, send_after)
  where status in ('queued','sending');
create index if not exists customer_notifications_customer_idx
  on public.customer_notifications (customer_id, created_at desc);
create index if not exists customer_notifications_kind_idx
  on public.customer_notifications (kind, created_at desc);
create index if not exists customer_notifications_branch_idx
  on public.customer_notifications (branch_id) where branch_id is not null;

alter table public.customer_notifications enable row level security;

drop policy if exists customer_notifications_admin_full on public.customer_notifications;
create policy customer_notifications_admin_full on public.customer_notifications
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists customer_notifications_branch_read on public.customer_notifications;
create policy customer_notifications_branch_read on public.customer_notifications
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 4. customer-uploads Storage bucket ---------------------------
--
-- Private bucket; reads + writes flow through signed URLs minted by
-- lib/uploadService.ts via the service-role admin client. We don't add
-- per-folder storage RLS policies — the route handler is the gate.
--
-- If storage extension isn't installed yet, this insert is a no-op
-- (the table doesn't exist). Apply Supabase's storage extension first.

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'storage' and table_name = 'buckets'
  ) then
    insert into storage.buckets (id, name, public)
    values ('customer-uploads', 'customer-uploads', false)
    on conflict (id) do nothing;
  end if;
end $$;

-- ============================================================================
-- Verification queries:
--
--   select count(*) from public.customer_otp_codes;        -- 0
--   select count(*) from public.customer_notifications;    -- 0
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='customers'
--     and column_name in ('lifecycle_stage','retention_score');  -- 2 rows
--   select id from storage.buckets where id = 'customer-uploads';
--
-- ============================================================================
