-- Phase 24 — Operational observability completion.
--
-- Delivery confirmation reaches the alert layer; the LINE operator
-- channel becomes real. Two small additive columns — no new tables.
--
--   1. alert_deliveries.provider_message_id — the provider's message
--      id (Resend email_id) captured at send time. The email webhook
--      matches it back to flip an alert email's delivery status from
--      'sent' → 'delivered' / 'failed' (true delivery confirmation
--      for operator alerts, not just customer notifications).
--
--   2. alert_preferences.line_target — a LINE user / group / room id
--      the operator alert channel pushes to for this scope. Per-branch
--      (branch row) or org-wide (global row). When absent, the global
--      ALERT_LINE_TARGET env applies; when that is also absent, LINE
--      routing safely no-ops.
--
-- All additive + idempotent.
--
-- ROLLBACK
--   alter table public.alert_deliveries  drop column if exists provider_message_id;
--   alter table public.alert_preferences drop column if exists line_target;

begin;

alter table public.alert_deliveries
  add column if not exists provider_message_id text;

create index if not exists alert_deliveries_provider_msg_idx
  on public.alert_deliveries (provider_message_id)
  where provider_message_id is not null;

alter table public.alert_preferences
  add column if not exists line_target text;

commit;
