# CareU OPS Platform — Role × Permission Matrix

> **Status:** permanent reference. UI guards in [`lib/permissions.ts`](../lib/permissions.ts) and DB policies in [RLS_POLICY.md](./RLS_POLICY.md) must match this matrix.

---

## 1. Roles

The 5 canonical roles (codes in [`lib/roles.ts`](../lib/roles.ts)):

| Code | Label (TH) | Label (EN) | Who |
|---|---|---|---|
| `owner` | เจ้าของกิจการ | Owner | Company CEO / shop owner |
| `hq_admin` | แอดมินสำนักงานใหญ่ | HQ admin | Central ops / pricing manager |
| `branch_manager` | ผู้จัดการสาขา | Branch manager | Branch owner / shop supervisor |
| `front_staff` | พนักงานหน้าร้าน | Front staff | Cashier / receptionist |
| `technician` | ช่างซ่อม | Technician | Repair / alteration craftsperson |

Legacy codes (`CEO`, `AREA_MANAGER`, `FRONT_DESK`, …) auto-map via `normalizeRole`.

---

## 2. Master matrix

Legend: ✅ = full access · 👁 = read only · 🏢 = own branch only · ❌ = no access · ⚠ = restricted (see note)

| Capability | owner | hq_admin | branch_manager | front_staff | technician |
|---|---|---|---|---|---|
| **Dashboard — Executive** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Dashboard — Manager** | ✅ | ✅ | ✅ (own branch) | ❌ | ❌ |
| **Dashboard — Accounting** | ✅ | ✅ | ✅ (own branch) | ❌ | ❌ |
| **Dashboard — Front Desk** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Dashboard — Production** | ✅ | ✅ | ✅ | ❌ | ✅ |
| **/intake** (create new order) | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ❌ |
| **/orders** (list) | ✅ all | ✅ all | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 |
| **/orders status change** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 |
| **/orders/[id]/document — view** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 |
| **/orders/[id]/document — payment change** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ❌ |
| **/orders/[id]/document — cost panel** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/customers** (list + edit) | ✅ all | ✅ all | ✅ 🏢 | ✅ 🏢 | 👁 🏢 |
| **/customers — import CSV** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **/customers — sync from sheet** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **/customers — view history** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | 👁 🏢 |
| **/invoices** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/expenses — view** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/expenses — add** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/expenses — sync from sheet** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **/reports/revenue** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/reports/profit** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/reports/branches (cross-branch)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **/reports/customers** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/reports/expenses** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **/pricing — view** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **/pricing — edit prices** | ✅ | ✅ | ⚠ own branch overrides | ❌ | ❌ |
| **/pricing — disable / enable** | ✅ | ✅ | ⚠ own branch overrides | ❌ | ❌ |
| **/pricing — sync to sheet** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Branch selector (top bar)** | ✅ all branches | ✅ all branches | 🏢 locked | 🏢 locked | 🏢 locked |
| **Order form — choose another branch** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Order form — business type override** | ✅ | ✅ | ✅ | ✅ | n/a |
| **Audit log (`order_audit_log`)** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **Manage staff (promote / demote / disable)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`/admin` centre + `/admin/staff` UI** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`/admin/recovery` UI (sync_failures + LINE log + receipt rebuild)** | ✅ all branches | ✅ all branches | ✅ 🏢 own branch | ❌ | ❌ |
| **Retry sync / resend LINE** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **Mark sync_failures resolved** | ✅ | ✅ | ✅ 🏢 (own branch only — gated via `/api/admin/recovery/resolve`) | ❌ | ❌ |
| **Bulk resolve via `/api/admin/recovery/bulk-resolve`** | ✅ all | ✅ all | ✅ 🏢 (per-row branch check) | ❌ | ❌ |
| **Run retry worker via `/api/admin/recovery/run-worker`** | ✅ any/all branches | ✅ any/all branches | ✅ 🏢 (branchCode forced to own) | ❌ | ❌ |
| **Cron retry tick via `/api/cron/retry-worker`** | ⚠ machine-only (Bearer CRON_SECRET) — no role gate; not callable from the UI | same | same | same | same |
| **LINE follow webhook `/api/line/webhook`** | ⚠ machine-only (LINE platform; verified by HMAC over LINE_CHANNEL_SECRET) | same | same | same | same |
| **`worker_runs` read** | ✅ all branches | ✅ all branches | ❌ (admin-only RLS policy) | ❌ | ❌ |
| **`line_follow_events` read** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`/admin/customer-line` UI** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Link / unlink / ignore LINE follower (`/api/admin/customer-line/*`)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Run reconcile (`/api/admin/reconcile/run`)** | ✅ any/all branches | ✅ any/all branches | ✅ 🏢 (branchCode forced to own) | ❌ | ❌ |
| **`reconcile_runs` read** | ✅ | ✅ | ❌ (admin-only RLS) | ❌ | ❌ |
| **`customer_line_links` write (link / unlink / ignore)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`/admin/payroll` UI** | ✅ | ✅ | ❌ (RLS read only on `payroll_periods` — UI not built) | ❌ | ❌ |
| **Payroll write (`/api/admin/payroll/*`)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`payroll_periods` read** | ✅ | ✅ | ✅ 🏢 (RLS) | ❌ | ❌ |
| **`technician_payroll_items` read** | ✅ | ✅ | ✅ 🏢 (RLS via period join) | ❌ | ❌ |
| **Refresh customer tier (`/api/admin/customer-tier/refresh`)** | ✅ any/all branches | ✅ any/all | ✅ 🏢 (branchCode forced to own) | ❌ | ❌ |
| **Customer tier badge on `/customers`** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 (read-only) | 👁 🏢 |
| **Refresh dashboard snapshot (`/api/admin/dashboard/refresh-snapshot`)** | ✅ | ✅ (also callable from cron via Bearer `CRON_SECRET`) | ❌ | ❌ | ❌ |
| **`dashboard_daily_snapshot` read** | ⚠ service-role only (revoked from authenticated) | same | same | same | same |
| **`reconcile_runs` read** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Dashboard summary (`/api/admin/dashboard/summary`)** | ✅ any/all | ✅ any/all | ✅ 🏢 (branchCode forced) | ✅ 🏢 | ✅ 🏢 |
| **Bonus engine in payroll UI** | ✅ (uses suggestion, free to override) | ✅ | ❌ | ❌ | ❌ |
| **`/admin/onboarding` UI** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Create branch (`/api/admin/onboarding/create-branch`)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Activate / deactivate branch (`/api/admin/onboarding/activate-branch`)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`/admin/dispatch` UI (customer_notifications monitor)** | ✅ all | ✅ all | ❌ | ❌ | ❌ |
| **Manual dispatch tick (`/api/admin/dispatch/run`)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Dispatch summary (`/api/admin/dispatch/summary`)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Resend notification (`/api/admin/notifications/resend`)** | ✅ all | ✅ all | ✅ 🏢 | ✅ 🏢 | ❌ |
| **Cancel notification (`/api/admin/notifications/cancel`)** | ✅ all | ✅ all | ✅ 🏢 | ✅ 🏢 | ❌ |
| **Manual lifecycle send (`/api/admin/notifications/send`)** | ✅ all | ✅ all | ✅ 🏢 | ✅ 🏢 | ❌ |
| **Twilio delivery webhook (`/api/webhooks/twilio-status`)** | ⚠ no role — Twilio signature verification via `TWILIO_AUTH_TOKEN` | same | same | same | same |
| **`/admin/crm/audiences` UI** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ❌ |
| **`/admin/crm/broadcasts` UI + drafts** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ❌ |
| **Audience estimate (`/api/admin/crm/audiences/estimate`)** | ✅ all | ✅ all | ✅ 🏢 (scoped customer pool) | ❌ | ❌ |
| **Broadcast drafts CRUD (`/api/admin/crm/broadcasts/*`)** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ❌ |
| **Send broadcast (`/api/admin/crm/broadcasts/[id]/send`)** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ❌ |
| **Pause / resume / cancel send_job (`/api/admin/crm/broadcasts/[id]/jobs/[jobId]`)** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ❌ |
| **Send job monitoring (`/admin/crm/broadcasts/[id]/jobs/[jobId]`)** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ❌ |
| **Feature flags CRUD (`feature_flags` table)** | ✅ | ✅ | 👁 read-only | 👁 read | 👁 read |
| **Cron broadcast-send (`/api/cron/broadcast-send`)** | ⚠ machine-only (Bearer CRON_SECRET) | same | same | same | same |
| **Worker telemetry (`/admin/system/workers`, `/api/admin/system/workers`)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Self-heal (`/api/admin/system/recover-workers`)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Communications settings UI (`/admin/settings/communications`)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Per-branch flag overrides (`/api/admin/settings/communications`)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Alert rules CRUD (`/api/admin/system/alert-rules`)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`feature_flags` read** | ✅ | ✅ | 👁 | 👁 | 👁 |
| **Engagement dashboard (`/admin/crm/engagement`, `/api/admin/crm/engagement`)** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ❌ |
| **Email templates UI + CRUD (`/admin/communications/templates`, `/api/admin/communications/templates/*`)** | ✅ | ✅ | 👁 read | ❌ | ❌ |
| **Template test-send (`/api/admin/communications/templates/[id]/test-send`)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Template restore (`/api/admin/communications/templates/[id]/restore`)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Cron engagement-aggregate (`/api/cron/engagement-aggregate`)** | ⚠ machine-only (Bearer CRON_SECRET) | same | same | same | same |
| **Cron retention-triggers (`/api/cron/retention-triggers`)** | ⚠ machine-only (Bearer CRON_SECRET) | same | same | same | same |
| **Cron comm-performance-aggregate (`/api/cron/comm-performance-aggregate`)** | ⚠ machine-only (Bearer CRON_SECRET) | same | same | same | same |
| **`branch_trigger_overrides` table** | ✅ | ✅ | ✅ 🏢 own branch | ❌ | ❌ |
| **`customer_branch_unsubscribes` table (admin read)** | ✅ all | ✅ all | ✅ 🏢 | ✅ 🏢 | ❌ |
| **`/admin/crm/triggers` UI + `/api/admin/crm/triggers`** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ❌ |
| **`/admin/settings/triggers` UI** | ✅ all | ✅ all | ✅ 🏢 own branch | ❌ | ❌ |
| **`GET/POST /api/admin/settings/branch-triggers`** | ✅ all | ✅ all | ✅ 🏢 (own-branch write only) | ❌ | ❌ |
| **`/admin/system/guardrails` UI** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`GET/POST /api/admin/system/guardrails` (engagement_guardrails CRUD + emergency stop)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`engagement_guardrails` table read** | ✅ | ✅ | 👁 (read all rows — read-only at UI layer) | ❌ | ❌ |
| **`engagement_guardrails` write** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`campaign_funnel_metrics` table read** | ✅ all | ✅ all | ✅ 🏢 own branch | ❌ | ❌ |
| **`POST /api/internal/attribute-order`** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 |
| **`POST /api/admin/crm/broadcasts/[id]/pause`** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ❌ |
| **`POST /api/admin/crm/broadcasts/[id]/resume`** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ❌ |
| **`worker_locks` table read** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`cron_failure_streaks` table read** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`/admin/system/smoke-test` UI** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`GET /api/admin/system/smoke-test`** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`alert_events` table read** | ✅ all | ✅ all | ✅ 🏢 own branch | ❌ | ❌ |
| **`GET /api/admin/system/alerts`** | ✅ all | ✅ all | ✅ 🏢 (own-branch events) | ❌ | ❌ |
| **`POST /api/admin/system/alerts` acknowledge / resolve** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **`POST /api/admin/system/alerts` run-maintenance** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Weekly campaign cap override (`overrideWeeklyCap`)** | ✅ owner only | ❌ | ❌ | ❌ | ❌ |
| **`/api/cron/worker-maintenance`** | ⚠ machine-only (Bearer CRON_SECRET) | same | same | same | same |
| **`/admin/system/alert-preferences` UI** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`GET/POST /api/admin/system/alert-preferences`** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`alert_preferences` table** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`alert_deliveries` table read** | ✅ all | ✅ all | ✅ 🏢 own branch | ❌ | ❌ |
| **`/api/admin/system/alerts` `send-digest` action** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`/api/cron/operator-digest`** | ⚠ machine-only (Bearer CRON_SECRET) | same | same | same | same |
| **`/admin/system/branch-health` UI** | ✅ all branches | ✅ all branches | ✅ 🏢 own branch | ❌ | ❌ |
| **`GET /api/admin/system/branch-health`** | ✅ all | ✅ all | ✅ 🏢 (own branch, server-scoped) | ❌ | ❌ |
| **`GET /api/admin/system/delivery-timeline`** | ✅ all | ✅ all | ✅ 🏢 | ✅ 🏢 | ❌ |
| **`alert_deliveries.provider_message_id` / `alert_preferences.line_target`** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`/api/cron/worker-maintenance` / `operator-digest` / all `/api/cron/*`** | ⚠ machine-only (Bearer CRON_SECRET) | same | same | same | same |
| **`/admin/system/delivery-trace` UI + `/api/admin/system/delivery-trace`** | ✅ all | ✅ all | ✅ 🏢 own branch | ❌ | ❌ |
| **`/admin/system/escalation-recipients` UI + `/api/admin/system/escalation-recipients`** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`/api/admin/system/incident-export`** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`webhook_audit_log` / `escalation_recipients` tables** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Provider webhooks (`/api/webhooks/*`, `/api/line/webhook`)** | ⚠ machine-only (provider HMAC signature) | same | same | same | same |
| **`/admin/settings/branches` UI + `/api/admin/settings/branch-public`** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`/admin/system/webhook-retries` UI** | ✅ all | ✅ all | ✅ 🏢 own branch (read) | ❌ | ❌ |
| **`GET /api/admin/system/webhook-retries`** | ✅ all | ✅ all | ✅ 🏢 own branch | ❌ | ❌ |
| **`POST /api/admin/system/webhook-retries` replay** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`/api/admin/system/alerts` `replay-escalation` action** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`webhook_retry_queue` table** | ✅ all | ✅ all | ✅ 🏢 own branch | ❌ | ❌ |
| **`/api/cron/webhook-retry`** | ⚠ machine-only (Bearer CRON_SECRET) | same | same | same | same |
| **Tracking redirect (`/api/track/click`, `/api/track/open`)** | ⚠ public — signed HMAC tokens | same | same | same | same |
| **Resend webhook (`/api/webhooks/email-status`)** | ⚠ Svix signature via `RESEND_WEBHOOK_SECRET` | same | same | same | same |
| **Portal unsubscribe (`/api/portal/unsubscribe`)** | n/a — customer cookie | n/a | n/a | n/a | n/a |
| **Portal DOB (`/api/portal/profile` PATCH `birthDate`)** | n/a — customer cookie | n/a | n/a | n/a | n/a |
| **Cron dispatch tick (`/api/cron/dispatch-worker`)** | ⚠ machine-only (Bearer CRON_SECRET) — no role gate | same | same | same | same |
| **Cron overdue-pickup sweep (`/api/cron/overdue-pickup-sweep`)** | ⚠ machine-only (Bearer CRON_SECRET) | same | same | same | same |
| **Cron HEIC transcode (`/api/cron/heic-transcode`)** | ⚠ machine-only (Bearer CRON_SECRET) | same | same | same | same |
| **Lifecycle event trigger (`/api/internal/lifecycle-event`)** | ✅ all | ✅ all | ✅ 🏢 (branch-scoped) | ✅ 🏢 | ✅ 🏢 |
| **`/admin/customers/[id]` UI (unified customer view)** | ✅ all | ✅ all | ✅ 🏢 (branch-scoped) | ✅ 🏢 | ❌ |
| **Admin customer read (`/api/admin/customers/[id]`)** | ✅ all | ✅ all | ✅ 🏢 (branch-scoped) | ✅ 🏢 | ❌ |
| **Portal phone-change (`/api/portal/phone-change/{request,verify}`)** | n/a — customer cookie required | n/a | n/a | n/a | n/a |
| **Portal preferences (`/api/portal/preferences`)** | n/a — customer cookie required | n/a | n/a | n/a | n/a |
| **Portal activity feed (`/api/portal/activity`)** | n/a — customer cookie required | n/a | n/a | n/a | n/a |
| **Public website (`/website`, `/branches/*`, `/services`, `/track`, `/quote`, `/about`, `/contact`)** | ⚠ anonymous — anyone can view; no PII surfaced | same | same | same | same |
| **Public job tracking (`/api/public/track`)** | anonymous — phone+jobId is the auth factor; rate-limited; returns branch label only | same | same | same | same |
| **Public quote submission (`/api/public/quote`)** | anonymous — rate-limited 5/hour/IP; writes to `quote_requests` (anon INSERT policy) | same | same | same | same |
| **`quote_requests` read** | ✅ all | ✅ all | ✅ 🏢 (own branch + null branch) | ✅ 🏢 (own branch) | ❌ |
| **`quote_requests` triage write** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ❌ |
| **`customer_tags` write** | ✅ | ✅ | ✅ 🏢 (customer in own branch) | ✅ 🏢 | ❌ |
| **`customer_notes` write** | ✅ | ✅ | ✅ 🏢 (branch_id matches) | ✅ 🏢 | ❌ |
| **`customer_activity` read** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | 👁 🏢 (read-only) |
| **`customer_channels` write** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ❌ |
| **Customer portal (`/portal/*`)** | n/a — customer cookie surface | same | same | same | n/a |
| **Customer OTP routes (`/api/portal/auth/request-otp` + `verify-otp`)** | anonymous; rate-limited; sets `careu_customer_session` cookie | same | same | same | same |
| **Customer portal data (`/api/portal/orders` + `[id]` + `profile`)** | requires customer cookie; `customer_id` match enforced | same | same | same | same |
| **Customer upload URL (`/api/portal/upload-url`)** | customer cookie; scope forced to own customer/order | same | same | same | same |
| **Anon quote upload URL (`/api/public/upload-url`)** | anonymous; rate-limited 10/hr/IP; scope always 'quote' | same | same | same | same |
| **`customer_otp_codes` read** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **`customer_notifications` read** | ✅ | ✅ | ✅ 🏢 (own branch) | ❌ | ❌ |
| **`customers.lifecycle_stage` + `retention_score`** | written by `crmProgressionService` (admin client); RLS read inherits the existing `customers` policies | same | same | same | n/a |
| **Manage branches (create / disable)** | ✅ | ⚠ propose only | ❌ | ❌ | ❌ |
| **technician_profiles — view list** | ✅ all | ✅ all | ✅ 🏢 | ✅ 🏢 (for assignment) | ✅ 🏢 (own row) |
| **technician_profiles — create / edit wage / target** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **technician_profiles — toggle active** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Order assignment (`orders.assigned_technician_id`)** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 (self-assign) |
| **Productivity KPI view** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ✅ own row only |
| **`/expenses` view + add** | ✅ all | ✅ all | ✅ 🏢 | ❌ | ❌ |
| **`/expenses` sync from sheet** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **payroll_periods — view** | ✅ all | ✅ all | 👁 🏢 (read only) | ❌ | ❌ |
| **payroll_periods — create / finalize / pay** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **technician_payroll_items — view** | ✅ all | ✅ all | 👁 🏢 (own branch only via period join) | ❌ | ❌ |
| **technician_payroll_items — edit (bonus / deduction)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **branch_monthly_profit view** | ✅ all branches | ✅ all branches | 👁 🏢 (own branch only) | ❌ | ❌ |
| **calculateBranchLaborCost** | ✅ | ✅ | ✅ 🏢 (own branch only) | ❌ | ❌ |
| **Dashboard — fetch snapshot (`fetchDashboardSnapshot`)** | ✅ all branches | ✅ all branches | ✅ 🏢 (own branch via RLS + client filter) | ✅ 🏢 (front-desk tab only) | ✅ 🏢 (production tab only) |
| **Dashboard — KPI bundle (`assembleKpis`)** | ✅ full bundle | ✅ full bundle | ✅ scoped bundle | ✅ operational subset (no financials) | ✅ workload-only subset |
| **Receipt view (`/orders/[id]/document`)** | ✅ all | ✅ all | ✅ 🏢 (RLS) | ✅ 🏢 (RLS) | ✅ 🏢 (RLS, view-only) |
| **Receipt print (A4 / thermal / mobile)** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 |
| **Save receipt as image** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 |
| **Receipt — internal cost panel (labor/material)** | ✅ | ✅ | ✅ 🏢 | ❌ | ❌ |
| **Receipt — payment status edit** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ❌ |
| **Receipt — sync to Google Sheet** | ✅ | ✅ | ✅ 🏢 | ✅ 🏢 | ✅ 🏢 (on own orders) |
| **LINE OA — trigger send** | ✅ all kinds | ✅ all kinds | ✅ 🏢 all kinds | ✅ 🏢 all kinds | ❌ |
| **`customer_line_links` — view** | ✅ all | ✅ all | ✅ 🏢 (via customer.branch_id) | ✅ 🏢 | ❌ |
| **`customer_line_links` — create / unsubscribe** | ✅ | ✅ | ❌ (PDPA — admin-controlled) | ❌ | ❌ |
| **`line_message_log` — read** | ✅ all branches | ✅ all branches | 👁 🏢 (own branch) | ❌ | ❌ |
| **`branch_line_configs` — view / rotate tokens** | ✅ (via service role) | ✅ (via service role) | ❌ | ❌ | ❌ |

---

## 3. Capability helpers (`lib/permissions.ts`)

The matrix above is encoded as pure functions:

| Helper | Returns true for |
|---|---|
| `canViewAllBranches(role)` | `owner`, `hq_admin` |
| `canViewReports(role)` | `owner`, `hq_admin`, `branch_manager` |
| `canCreateOrder(role)` | `owner`, `hq_admin`, `branch_manager`, `front_staff` |
| `canManagePricing(role)` | `owner`, `hq_admin` |
| `canManageStaff(role)` | `owner`, `hq_admin` |
| `canSeeFinancials(role)` | `owner`, `hq_admin`, `branch_manager` |
| `canChooseAnotherBranch(role)` | `owner`, `hq_admin` |
| `canEditOrderCosts(role)` | `owner`, `hq_admin`, `branch_manager` |
| `canChangeJobStatus(role)` | everyone except an unknown role |

**Rule:** UI surfaces consult these helpers. The matrix in this doc is the spec; the helpers are the implementation. PRs change them together.

---

## 4. Branch-scope semantics

A row in `orders` / `customers` is owned by exactly one branch (`branch_id text` matching `branches.code`).

| Role | What "own branch only" means |
|---|---|
| `owner`, `hq_admin` | Their session has no branch filter. They see every branch in every table. |
| `branch_manager`, `front_staff`, `technician` | `profiles.branch_id` resolved to `branches.code` is the only branch they can read/write. Branch selector in sidebar is locked. |

Cross-branch reads attempted by a branch-locked role are denied at three layers:
1. The branch selector is disabled, so they cannot navigate to another branch's filter.
2. The route handlers (server-side) read `branch_id` from the session, not the request body.
3. RLS policies (next-phase) on `orders` / `customers` filter by `current_user_branch_code()`.

---

## 5. Sidebar navigation visibility

The sidebar reads `role.pages` and shows only items the role can access. Items are grouped operationally so the screens used most often (intake, orders, customers) sit at the top of each role's nav. Today's per-role nav set:

| Role | Operations | Finance | Management |
|---|---|---|---|
| `owner` | Dashboard, Walk-in intake, Orders, Customers | Invoices, Expenses, Reports | Pricing, **Admin centre**, **Recovery** |
| `hq_admin` | Dashboard, Walk-in intake, Orders, Customers | Invoices, Expenses, Reports | Pricing, **Admin centre**, **Recovery** |
| `branch_manager` | Dashboard, Walk-in intake, Orders, Customers | Invoices, Expenses, Reports | Pricing, **Recovery** (own branch) |
| `front_staff` | Dashboard, Walk-in intake, Orders, Customers | — | — |
| `technician` | Dashboard, Orders | — | — |

`canAccessPage(role, page)` is the single source of truth — see [`lib/roles.ts`](../lib/roles.ts). Two management-tier page keys today:
- `"admin"` gates `/admin` and `/admin/staff`. Only `owner` and `hq_admin` have it (via their `["*"]` set).
- `"recovery"` gates `/admin/recovery`. Granted to `owner`, `hq_admin`, and `branch_manager`. The branch_manager view is scoped to their branch by RLS (`sync_failures_branch_read`) + `requireBranchAccess` in `/api/admin/recovery/resolve`.

---

## 6. Google Sheet access

The `SUPABASE_SERVICE_ROLE_KEY` and the `GOOGLE_*` keys are NOT scoped per role — they are deployment-wide. The route handlers themselves are the role check.

| Sync route | Roles allowed to trigger |
|---|---|
| `POST /api/sync-order-to-sheet` | Any role with `canCreateOrder` (front_staff and above) — the route is called automatically after order create + manually from the document page. |
| `POST /api/sync-pricing-to-sheet` | `canManagePricing` (`owner`, `hq_admin`) — surfaced from `/pricing` only. |
| `POST /api/sync-customers` | `canManagePricing` today (called from `/customers` "ซิงค์จาก Google Sheet"). Next phase: gate by `canManageStaff`. |
| `POST /api/sync-expenses` | `canSeeFinancials` (`owner`, `hq_admin`, `branch_manager`). |
| `GET /api/debug-sheet[?dryRun=1]` | `owner` / `hq_admin` only — diagnostic. Today no route-level enforcement; add `canManageStaff` check in next phase. |

---

## 7. LINE OA send

Today: stubbed. Once `LINE_CHANNEL_ACCESS_TOKEN` is configured, sending a customer message from `/orders/[id]/document` requires:

| Action | Roles |
|---|---|
| Send Line OA from receipt page | `owner`, `hq_admin`, `branch_manager`, `front_staff` |
| Configure LINE channel (env vars) | Deploy admin (out of band) |
| Customise message template | `owner`, `hq_admin` (next phase: `/admin/templates`) |

---

## 8. Cross-cutting financial visibility rule

If a screen contains profit / margin / cost / labor / material values, it must be wrapped in `if (canSeeFinancials(role))`. This is the easiest gate to forget. Use the helper, never inline the role list.

```tsx
import { canSeeFinancials } from "@/lib/permissions";
import { useRole } from "@/lib/roleContext";

const { role } = useRole();
if (!canSeeFinancials(role)) return null;
// ... profit numbers below ...
```

---

## 9. First-user bootstrap

The very first LINE login on a fresh database is bootstrapped as `role='owner'` in [`app/api/auth/line/callback/route.ts`](../app/api/auth/line/callback/route.ts).

After that, every new user defaults to `role='front_staff'`. Promotion to `branch_manager`, `hq_admin`, etc. is done by an existing `owner`/`hq_admin` via SQL today; next phase adds an `/admin/staff` UI.

---

## 10. Audit visibility

The audit log (`public.order_audit_log`) is read-only and visible to **owner** / **hq_admin** / **branch_manager** (filtered to own branch via a join on `orders`). The UI to surface it lives in the next phase; for now, queries hit the table directly.

---

## 11. Editing this matrix

This document defines the contract. Whenever a permission changes:

1. Update the row in this matrix.
2. Update the matching helper in `lib/permissions.ts`.
3. Update the policy in `RLS_POLICY.md` (and the next-phase SQL in the migration).
4. Add a row to the changelog at the bottom of this file.

---

## 12. Changelog

| Date | Change | Commit |
|---|---|---|
| 2026-05-13 | Initial 5-role matrix established. | 4805d3b |
| 2026-05-14 | Added `admin` page key. `/admin` + `/admin/staff` UI surfaces owner / hq_admin staff management (role, branch, active, wage, skills). Sidebar grouped Operations / Finance / Management. | — |
| 2026-05-14 | Added `recovery` page key. `/admin/recovery` UI gives owner / hq_admin (all branches) + branch_manager (own branch) sync_failures + LINE log visibility, with retry / resend / resolve / receipt-rebuild actions. Migration `20260528` adds branch-scoped read on `sync_failures` and extends `kind` CHECK with `'line_send'` + `'receipt_rebuild'`. | — |
| 2026-05-14 | Phase 20 — operator controls. Added `/admin/settings/triggers` (branch_manager own-branch write), `/admin/system/guardrails` (owner/HQ + emergency stop), `engagement_guardrails` + `campaign_funnel_metrics` tables, and `/api/internal/attribute-order` for server-side campaign attribution. Migration `20260544`. | — |
| 2026-05-14 | Phase 21 — broadcast engine maturity. Added `worker_locks` (concurrency control), `cron_failure_streaks` (×N badges in workers UI), broadcast-draft pause/resume (`/api/admin/crm/broadcasts/[id]/pause` + `/resume`), cross-draft overlap pre-flight at send-create, broadcast delivery callback wired into Resend + Twilio webhooks, `/admin/system/smoke-test` page. Migration `20260545`. | — |
| 2026-05-15 | Phase 22 — cap enforcement + alert routing. Send-create now enforces emergency stop + daily/weekly caps + dry-run requirement (owner-only weekly override). Added `alert_events` table + `/api/admin/system/alerts` (ack/resolve/run-maintenance), `worker-maintenance` cron (lock janitor + alert sweep), broadcast URL auto-wrap. Migration `20260546`. | — |
| 2026-05-15 | Phase 23 — alert delivery + weekly digest. Added `alert_preferences` + `alert_deliveries` tables, `/admin/system/alert-preferences` (owner/HQ), real email routing via `lib/channels/email`, escalation cooldown, `operator-digest` cron + `send-digest` action. Migration `20260547`. | — |
| 2026-05-15 | Phase 24 — operational observability. Alert-email delivery confirmation, real LINE operator channel, declarative cron manifest (`vercel.json` + `lib/cronManifest.ts`), cron health dashboard (next-run + recovery hints), `/admin/system/branch-health` (branch_manager own-branch), tiered escalation chain, delivery audit trail (`<DeliveryTimeline>`). Migration `20260548`. | — |
| 2026-05-15 | Phase 25 — trustworthiness hardening. Webhook signature/replay/audit hardening (`webhook_audit_log`), cron manifest drift guard, role-tiered `escalation_recipients` with mute, delivery trace explorer, provider reliability metrics, incident snapshot export. Migration `20260549`. | — |
| 2026-05-15 | Phase 26 — communication reliability completion. Webhook retry queue + dead-letter (`webhook_retry_queue`), provider-agnostic delivery receipt adapter, multi-target LINE escalation fan-out, manifest CI gate (`prebuild` hook), dead-letter explorer + replay console. Migration `20260550`. | — |
| 2026-05-15 | Phase 27A — customer portal polish. Order-history filters, reorder (`/api/portal/reorder`), saved customer preferences, notification centre (`/portal/notifications`), attachment HEIC fallback, session UX. All customer-cookie scoped — no operator-role surface. Migration `20260551`. | — |
| 2026-05-15 | Phase 27B — public website maturity. Homepage sections, dynamic `/branches/[code]` + `/services/[slug]` SEO pages, 4-step quote wizard with safe uploads + localStorage draft-save. Anonymous/public surface — no operator-role change. Migration `20260552`. | — |
| 2026-05-15 | Phase 27D — franchise-safe public layer. `/admin/settings/branches` + `/api/admin/settings/branch-public` (owner/HQ) operator UI for branch public settings; dynamic open/closed status; public smoke-test category. Migration `20260553`. | — |
| 2026-05-16 | Phase 27C — SEO & performance deep pass. Canonical URLs + `metadataBase`, `Organization`/`WebSite`/`BreadcrumbList` + enriched `LocalBusiness` JSON-LD, dynamic `next/og` OG images, `loading.tsx` skeletons, public `not-found.tsx`, skip-link + global focus ring. Public/customer surface only — no operator-role change. No migration. | — |
| 2026-05-16 | Bug-fix phase — storefront workflow stabilization. Hourly `sync-customers` cron (auto customer import + visit/spend recalc); phone leading-zero normalization on display + insert; robust visit/spend recalc (`lib/customerRecalc.ts`, cancelled orders excluded, paginated); intake service dropdown shows all `service_prices` + "Other" custom-service path; intake `due_date` wired; Orders page create-form removed (creation lives at `/intake`). No migration. No role-matrix change. | — |
| 2026-05-16 | Store Ops Hardening Phase A — multi-item repair intake. Migration `20260554` adds `public.order_items` (child of `orders`). New `IntakeOrderForm` at `/intake`: many garments per ticket, each with service/custom-service/detail/price/qty/urgent-fee/due-date/technician/notes; receipt renders one line per item. Operational surface only — same intake roles, no role-matrix change. | — |
| 2026-05-16 | Store Ops Hardening Phase B — Orders Operations Board. `/orders` rebuilt as a front-counter board: queue chips (today/overdue/urgent/ready/waiting-payment) + technician filter + search, mobile-first operations cards, inline status change. `statusBadges` extended additively with `waiting_parts`/`outsource`/`delivered` (free-text column — no migration). No role-matrix change — same orders-page visibility. | — |
| 2026-05-16 | Store Ops Hardening — data integrity. Unmatched-order resolver: `/customers` "จับคู่ใบงาน" links orphan orders (`customer_id` NULL) to a customer so visits/spend count (`UnmatchedOrdersModal`, writes `orders.customer_id` only). Removed the duplicated legacy intake form (`SmartOrderForm.tsx` deleted — `IntakeOrderForm` is the single intake path). No migration, no role-matrix change. | — |
| 2026-05-16 | Store Ops Hardening — per-item tracking. Migration `20260555` adds `order_items.status` (same vocabulary as `orders.status`). `OrderDetailModal` now lists each garment in a multi-item ticket with its own status changer, urgent flag, due date, and notes. No role-matrix change. | — |
| 2026-05-16 | Store Ops Hardening — per-item image workflow. `OrderItemImages` captures repair photos per garment (intake + post-repair) into `order_items.image_paths`. New auth'd routes `/api/admin/upload-url` + `/api/admin/order-images` (owner/HQ/branch_manager/front_staff/technician) reuse the existing signed-URL storage pipeline. Tablet/mobile camera capture + preview. No migration. | owner · hq_admin · branch_manager · front_staff · technician (operator photo upload) |
| 2026-05-16 | Store Ops Hardening — operations board refinement. `/orders` board gains a QC queue (`completed` = repaired, awaiting check) and branch filtering: owner/HQ pick any branch, branch-locked roles are pinned to their own branch (board branch-isolation). No migration. | branch-locked roles see only their branch on `/orders` |

---

**Last updated:** 2026-05-16 (Store Ops Hardening — operations board refinement)
