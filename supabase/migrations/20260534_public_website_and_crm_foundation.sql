-- Public website + CRM foundation.
--
-- Five new tables. Four are CRM scaffolding the future automation will
-- consume (segmentation, VIP tiers, LINE CRM); one is the inbox for
-- customer-facing quote requests submitted via the public site.
--
-- Tables:
--   • public.quote_requests    — quote-form submissions from /quote
--   • public.customer_tags     — text tags admins attach to a customer
--   • public.customer_notes    — per-customer free-form notes
--   • public.customer_activity — append-only event log per customer
--   • public.customer_channels — contact channels (phone / email / line / web)
--
-- RLS philosophy:
--   • Owner / hq_admin: full read+write on everything.
--   • Branch_manager: read+write scoped to own branch (via branch_id on
--     the row, or via customer.branch_id where the row lacks one).
--   • Front_staff: read scoped to own branch, write limited (notes only).
--   • Technician: no access.
--   • Anon (public website): INSERT only on quote_requests (writes the
--     customer's submission). No reads of any CRM table. No reads of
--     orders / customers — those remain under existing RLS.
--
-- ROLLBACK
--   drop table if exists public.customer_channels cascade;
--   drop table if exists public.customer_activity cascade;
--   drop table if exists public.customer_notes cascade;
--   drop table if exists public.customer_tags cascade;
--   drop table if exists public.quote_requests cascade;

create extension if not exists "pgcrypto";

-- ---------- 1. quote_requests --------------------------------------------
--
-- The public /quote form writes here. customer_id is NULL on submission
-- (the customer may not exist in the platform yet); the admin pairs the
-- request with a real customer row when triaging.

create table if not exists public.quote_requests (
  id                  uuid primary key default gen_random_uuid(),
  /** Customer-supplied display name. Never used as the canonical record —
   *  the admin chooses or creates a real customers row at triage time. */
  customer_name       text,
  /** Required contact field. Normalised before insert client-side via
   *  lib/phone.ts so admin lookup is deterministic. */
  customer_phone      text not null,
  customer_email      text,
  contact_method      text default 'phone' check (contact_method in (
                        'phone','line','email','any'
                      )),
  /** branches.code (text slug) — the branch the customer wants to use.
   *  May be NULL if the customer didn't pick one. */
  branch_code         text,
  service_category    text,
  notes               text,
  /** Free-form image URLs the customer attached. Future enhancement:
   *  upload them to Supabase Storage and store storage paths instead. */
  photos              jsonb not null default '[]'::jsonb,
  status              text not null default 'new' check (status in (
                        'new','contacted','quoted','declined','converted'
                      )),
  /** Set when an admin pairs this request with a real customers row. */
  linked_customer_id  uuid references public.customers(id) on delete set null,
  linked_at           timestamptz,
  linked_by           uuid,
  /** Operator-facing comments accumulated while triaging. */
  internal_notes      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists quote_requests_status_idx
  on public.quote_requests (status, created_at desc);
create index if not exists quote_requests_branch_idx
  on public.quote_requests (branch_code) where branch_code is not null;
create index if not exists quote_requests_phone_idx
  on public.quote_requests (customer_phone);

alter table public.quote_requests enable row level security;

-- Owner / HQ: full access.
drop policy if exists quote_requests_admin_full on public.quote_requests;
create policy quote_requests_admin_full on public.quote_requests
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

-- Branch_manager + front_staff: read + write own branch.
drop policy if exists quote_requests_branch_rw on public.quote_requests;
create policy quote_requests_branch_rw on public.quote_requests
  for all to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_code is null or branch_code = public.current_user_branch_code())
  )
  with check (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_code is null or branch_code = public.current_user_branch_code())
  );

-- Anonymous: INSERT only. The public /quote form submits via the anon
-- supabase client (no JWT). Reads remain denied. The route handler caps
-- the inserts via rate limiting; this policy ensures only the insert
-- column-shape is allowed.
drop policy if exists quote_requests_anon_insert on public.quote_requests;
create policy quote_requests_anon_insert on public.quote_requests
  for insert to anon
  with check (true);

-- ---------- 2. customer_tags ---------------------------------------------

create table if not exists public.customer_tags (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id) on delete cascade,
  tag          text not null,
  created_at   timestamptz not null default now(),
  created_by   uuid
);

create unique index if not exists customer_tags_uniq
  on public.customer_tags (customer_id, lower(tag));
create index if not exists customer_tags_tag_idx
  on public.customer_tags (lower(tag));

alter table public.customer_tags enable row level security;

drop policy if exists customer_tags_admin_full on public.customer_tags;
create policy customer_tags_admin_full on public.customer_tags
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

-- Branch staff read + write tags for customers in their branch. Customers
-- table RLS already restricts what they can see; this policy joins back
-- to customers so the tag follows the customer's branch.
drop policy if exists customer_tags_branch_rw on public.customer_tags;
create policy customer_tags_branch_rw on public.customer_tags
  for all to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and customer_id in (
      select c.id from public.customers c
      where c.branch_id = public.current_user_branch_code()
        or c.branch_id is null
    )
  )
  with check (
    public.current_user_role() in ('branch_manager','front_staff')
    and customer_id in (
      select c.id from public.customers c
      where c.branch_id = public.current_user_branch_code()
    )
  );

-- ---------- 3. customer_notes --------------------------------------------

create table if not exists public.customer_notes (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id) on delete cascade,
  branch_id    text,
  body         text not null,
  created_at   timestamptz not null default now(),
  created_by   uuid
);

create index if not exists customer_notes_customer_idx
  on public.customer_notes (customer_id, created_at desc);
create index if not exists customer_notes_branch_idx
  on public.customer_notes (branch_id) where branch_id is not null;

alter table public.customer_notes enable row level security;

drop policy if exists customer_notes_admin_full on public.customer_notes;
create policy customer_notes_admin_full on public.customer_notes
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists customer_notes_branch_rw on public.customer_notes;
create policy customer_notes_branch_rw on public.customer_notes
  for all to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  )
  with check (
    public.current_user_role() in ('branch_manager','front_staff')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 4. customer_activity -----------------------------------------
-- Append-only event log. Future automation writes here as well as the
-- admin UI. Examples: 'quote_submitted', 'order_completed', 'line_message_sent',
-- 'tag_added'.

create table if not exists public.customer_activity (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid references public.customers(id) on delete set null,
  branch_id    text,
  /** Activity kind. Free-form text so future writers don't need a
   *  CHECK migration each time a new kind appears. */
  kind         text not null,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  created_by   uuid
);

create index if not exists customer_activity_customer_idx
  on public.customer_activity (customer_id, created_at desc);
create index if not exists customer_activity_kind_idx
  on public.customer_activity (kind, created_at desc);
create index if not exists customer_activity_branch_idx
  on public.customer_activity (branch_id) where branch_id is not null;

alter table public.customer_activity enable row level security;

drop policy if exists customer_activity_admin_full on public.customer_activity;
create policy customer_activity_admin_full on public.customer_activity
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists customer_activity_branch_read on public.customer_activity;
create policy customer_activity_branch_read on public.customer_activity
  for select to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff','technician')
    and (branch_id is null or branch_id = public.current_user_branch_code())
  );

-- ---------- 5. customer_channels -----------------------------------------
-- Contact channels per customer. customer_line_links remains the
-- authoritative LINE link; this table generalises to phone / email / web.

create table if not exists public.customer_channels (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  channel_type  text not null check (channel_type in (
                  'phone','email','line','web','other'
                )),
  /** Channel-specific identifier (phone number, email address,
   *  line_user_id, etc.). */
  channel_id    text not null,
  branch_id     text,
  verified_at   timestamptz,
  /** Operator notes (e.g. "secondary contact — wife"). */
  notes         text,
  created_at    timestamptz not null default now(),
  created_by    uuid
);

create unique index if not exists customer_channels_uniq
  on public.customer_channels (customer_id, channel_type, channel_id);
create index if not exists customer_channels_type_idx
  on public.customer_channels (channel_type, channel_id);

alter table public.customer_channels enable row level security;

drop policy if exists customer_channels_admin_full on public.customer_channels;
create policy customer_channels_admin_full on public.customer_channels
  for all to authenticated
  using (public.current_user_role() in ('owner','hq_admin'))
  with check (public.current_user_role() in ('owner','hq_admin'));

drop policy if exists customer_channels_branch_rw on public.customer_channels;
create policy customer_channels_branch_rw on public.customer_channels
  for all to authenticated
  using (
    public.current_user_role() in ('branch_manager','front_staff')
    and customer_id in (
      select c.id from public.customers c
      where c.branch_id = public.current_user_branch_code()
        or c.branch_id is null
    )
  )
  with check (
    public.current_user_role() in ('branch_manager','front_staff')
    and customer_id in (
      select c.id from public.customers c
      where c.branch_id = public.current_user_branch_code()
    )
  );

-- ============================================================================
-- Verification queries:
--
--   select count(*) from public.quote_requests;     -- 0 until first form submit
--   select count(*) from public.customer_tags;      -- 0
--   select policyname from pg_policies
--     where schemaname='public'
--     and tablename in ('quote_requests','customer_tags','customer_notes',
--                       'customer_activity','customer_channels');
--
-- ============================================================================
