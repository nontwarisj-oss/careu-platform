# CareU OPS Platform — Incident Response

> **Status:** operator runbook. When an alert fires or a dashboard goes red, start here.

---

## 1. Triage order

1. **Open `/admin/system/workers`** — overall banner: healthy / warning / critical.
2. **Read the Active alerts section** — severity, source worker, occurrence + escalation count.
3. **Acknowledge** the alert you are taking — this stops escalation re-routes while you work.
4. **Open `/admin/system/branch-health`** — is the impact one branch or platform-wide?
5. Fix → the alert auto-resolves on the next `worker-maintenance` sweep, or **Resolve** it manually.

---

## 2. Alert playbook

| Alert metric | Likely cause | First action |
|---|---|---|
| `cron_silence_minutes` | A cron stopped ticking | `/admin/system/workers` → check the cron's last run; verify the Vercel scheduler; hit `/api/cron/<name>` manually. |
| `dead_letter_count` | Provider rejecting messages | Check provider config (Twilio / Resend / LINE env); inspect `customer_notifications` dead-letter rows + `error_reason`. |
| `queue_age_minutes` | Dispatch worker not draining | **Self-heal** on the workers page; check `dispatch-worker` cron health. |
| `delivery_success_pct` low | Provider outage or bad numbers | Check `notification_dispatch_log` failure reasons; verify provider status page. |
| `failure_count` | Transient provider/network errors | Watch one or two more ticks; retry-worker should recover them. |

---

## 3. Common recoveries

| Situation | Recovery |
|---|---|
| Rows stuck in `sending` | Workers page → **Self-heal** (resets to `queued`). |
| Stale `worker_locks` (crashed tick) | Workers page → **Run maintenance**, or wait for the 15-min sweep. |
| Broadcast job stuck `processing` | `/admin/crm/broadcasts/[id]` → pause the draft, investigate, resume. |
| Campaign over a send cap | `/admin/system/guardrails` — raise the cap or wait for the window to roll. |
| Everything must stop NOW | `/admin/system/guardrails` → **emergency stop** (halts dispatch + retention + broadcast within ~60s). |

---

## 4. Delivery investigation

For "did customer X get message Y?": open `/admin/customers/[id]`, find the notification, click **trail** → the [delivery audit trail](./COMMUNICATIONS.md) shows queued → dispatched → provider accepted → delivered → opened / clicked / failed, merged from `customer_notifications` + `notification_dispatch_log` + `communication_events`.

For operator-alert emails: `/admin/system/workers` → **Alert delivery history** shows sent / delivered / failed / skipped per channel.

---

## 5. Escalation contacts

The escalation chain is configured in `/admin/system/alert-preferences`:

- **Branch tier** — branch-row recipients (branch manager).
- **HQ tier** — global-row recipients; reached after one unresolved 2h cooldown.
- **Owner tier** — every cooldown after that.

If an alert reaches owner tier it has been unresolved for 4+ hours — treat as a real incident.

---

## 6. Delivery trace explorer (Phase 25)

`/admin/system/delivery-trace` — search any notification by provider message id, customer id, phone, status, or campaign (`broadcastJobId`). Each result expands to the full delivery audit trail. This is the first stop for "what happened to message X".

## 7. Incident snapshot export (Phase 25)

Every alert on `/admin/system/workers` has an **Export** button → downloads an incident snapshot (markdown) bundling the timeline, escalation chain, cron heartbeats, and provider payloads. `GET /api/admin/system/incident-export?alertEventId=…&format=json|md` (or `?notificationId=…`). Attach the export to a support ticket or postmortem.

## 8. Webhook trust failures (Phase 25)

`/admin/system/workers` → **Webhook trust** shows invalid-signature / malformed / handler-error counts over 24h. A spike in `invalid_signature` means either a misconfigured provider secret or probe traffic — verify `TWILIO_AUTH_TOKEN` / `RESEND_WEBHOOK_SECRET` / `LINE_CHANNEL_SECRET`. Replays are benign (caught + ignored).

## 9. Escalation recipient management (Phase 25)

`/admin/system/escalation-recipients` — role-tiered contacts (owner / hq_admin / branch_manager / technician_lead) with per-recipient severity floors, branch scope, and a **temporary mute** (e.g. mute a recipient 24h during planned maintenance). The escalation chain widens the audience per tier; muted recipients are skipped + counted.

---

**Last updated:** 2026-05-15 (phase 25 — trustworthiness hardening)
