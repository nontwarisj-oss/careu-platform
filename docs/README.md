# CareU OPS — `/docs`

Permanent reference framework for the platform. **Future code must follow these documents.** If you find drift, fix the code — not the doc — unless this README's changelog says otherwise.

| Doc | Read when… |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | onboarding, designing a new module, judging if a change is "in the spirit" of the system. |
| [WORKFLOW.md](./WORKFLOW.md) | building a feature that touches Care U or Ezy Repair's day-to-day. |
| [RLS_POLICY.md](./RLS_POLICY.md) | writing a migration that touches `branches` / `profiles` / `orders` / `customers` / `expenses` / `service_prices` / `order_audit_log`. |
| [ROLE_MATRIX.md](./ROLE_MATRIX.md) | adding a button / page / API route that needs a permission check. |
| [PRICING_RULES.md](./PRICING_RULES.md) | changing prices, promotions, urgent fees, or anything in `computeDiscount`. |
| [JOB_ID_RULES.md](./JOB_ID_RULES.md) | changing how orders are identified or counted. |
| [GOOGLE_SHEET_SYNC.md](./GOOGLE_SHEET_SYNC.md) | touching anything under `/api/sync-*` or `lib/googleSheets.ts`. |

## Operating rules

1. **One source of truth per fact.** If the doc disagrees with code, raise a PR that fixes the one that is wrong. Don't paper over with a note.
2. **Every PR that affects a doc'd contract updates the doc in the same commit.** Drift between code and docs is treated like a failing test.
3. **Each doc carries a "Last updated" timestamp and commit hash.** Bump both when you edit.

## Audience

These docs are written for:
- **Future developers** picking up the platform cold.
- **AI agents** (Claude Code, etc.) writing PRs. The docs are deliberately structured so an LLM can navigate code by reading docs first.
- **The owner**, when something breaks and they need to know who to ask or what to expect.
