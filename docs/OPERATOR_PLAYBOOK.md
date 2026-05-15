# CareU OPS Platform — Operator Playbook

> **Status:** daily / weekly operating routine for owners, HQ admins, and branch managers.

For incident handling see [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md). For configurable controls see [OPERATOR_CONTROLS.md](./OPERATOR_CONTROLS.md).

---

## 1. Daily checks (≈ 2 minutes)

| Check | Where | Healthy looks like |
|---|---|---|
| Worker health | `/admin/system/workers` | banner green; no streak badges; no missed "next expected run". |
| Branch health | `/admin/system/branch-health` | all branch cards green. |
| Open alerts | workers page → Active alerts | empty, or all acknowledged + being worked. |
| Queue depth | workers page → Queue health | queued small; dead-letter 0. |

A branch manager does the same on `/admin/system/branch-health` — scoped to their branch.

---

## 2. Weekly checks (≈ 10 minutes)

- **Operator digest** — arrives by email Monday (sales / failed jobs / broadcast / CRM engagement / payroll warnings / branch comparison). Skim it; it is the week in one screen. Trigger early with **Send digest** on the workers page.
- **Alert delivery history** — workers page; confirm alerts are actually reaching inboxes (not all `skipped`).
- **Payroll warnings** — the digest flags `open` payroll periods past their end date — finalize them.
- **Smoke test** — `/admin/system/smoke-test` before onboarding a new branch or after a deploy.

---

## 3. Before sending a campaign

1. Audience looks right on `/admin/crm/broadcasts/[id]`.
2. Run a **dry-run** — required when the `dry_run_required` guardrail is on.
3. Send live. Caps (daily / weekly / emergency stop) are enforced at send-create — a clear reason is returned if blocked.
4. Watch `broadcast-send` on the workers page drain the job.

---

## 4. Setup checklist (one-time per deployment)

| Item | Where |
|---|---|
| Cron schedules | [`vercel.json`](../vercel.json) — deployed automatically. |
| Alert recipients + LINE target | `/admin/system/alert-preferences`. |
| Email provider | env: `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY`, `EMAIL_FROM`. |
| Slack alerts (optional) | env: `ALERT_SLACK_WEBHOOK_URL`. |
| LINE operator alerts (optional) | env: `ALERT_LINE_TOKEN` + a `line_target` per scope. |
| Guardrail caps | `/admin/system/guardrails`. |
| Verify everything | `/admin/system/smoke-test` — all green. |

---

## 5. Escalation expectations

- A new alert emails the branch recipients immediately (unless quiet hours hold a non-critical one).
- Unacknowledged after ~2h → re-routes as **HQ escalation**.
- Unacknowledged after ~4h → **owner escalation**.
- **Acknowledge** an alert as soon as you start working it — that pauses escalation.

---

## 6. Phase 25 surfaces

| Need | Where |
|---|---|
| "What happened to message X?" | `/admin/system/delivery-trace` — search by provider id / phone / campaign. |
| Manage who gets paged | `/admin/system/escalation-recipients` — role tiers, severity, mute. |
| Mute a contact during maintenance | escalation-recipients → **mute 24h**. |
| Provider acting up? | `/admin/system/workers` → Provider reliability + Webhook trust. |
| Cron config drifted? | `/admin/system/workers` → Cron manifest drift. |
| Hand an incident to support | alert row → **Export** (markdown snapshot). |

Add to the **daily check**: glance at Webhook trust (0 bad) + Cron manifest drift (in sync) on the workers page.

---

**Last updated:** 2026-05-15 (phase 25 — trustworthiness hardening)
