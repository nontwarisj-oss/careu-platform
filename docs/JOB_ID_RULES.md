# CareU OPS Platform — Job ID Rules

> **Status:** permanent reference. Two strategies (manual + auto), one schema, zero overlap.

---

## 1. Why two strategies

Care U and Ezy Repair have different ergonomics at the counter:

- **Care U**: low daily volume, mostly returning customers, staff prefer short memorable ids that fit the garment's tag (`CARE-241`, `0513-A`, `JOB-7`).
- **Ezy Repair**: higher daily volume, parallel technicians working the shoe / bag queue, accountants need a predictable receipt sequence.

So:
- **Care U → manual.** Staff types the id; the system enforces uniqueness.
- **Ezy Repair → auto.** Postgres generates `BRANCHCODE-YYMMDD-SEQ` atomically.

Both ids land in the same column (`public.orders.job_id text`) and share one unique index.

---

## 2. Schema

```sql
alter table public.orders add column if not exists job_id text;

-- Scoped uniqueness: same id allowed across branches OR business types.
drop index if exists orders_job_id_unique_idx;
create unique index if not exists orders_job_id_scoped_idx
  on public.orders (branch_id, business_type, job_id) where job_id is not null;

create table public.job_id_sequence (
  branch_code   text not null,
  business_type text not null,
  for_date      date not null,
  last_seq      integer not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (branch_code, business_type, for_date)
);
```

The index is **partial** (`where job_id is not null`) so legacy rows with NULL job_id don't conflict. New rows always get a non-null job_id once a branch is migrated.

---

## 3. Care U — manual rules

| Rule | Detail |
|---|---|
| Required | Yes. Submitting the form with an empty job_id returns "Care U ต้องกรอก Job ID เอง". |
| Character set | `^[A-Za-z0-9_\-./]{1,32}$` (validated client-side in `lib/jobId.ts::normalizeJobId`). |
| Normalisation | Trim + uppercase. Storage is always uppercase. |
| Uniqueness scope | `(branch_id, business_type='care_u', job_id)`. Same id may appear in another branch or under Ezy. |
| Duplicate signal | Pre-check via `select count(*) from orders where job_id=$1 and branch_id=$2 and business_type='care_u'`. Race-loser handled by Postgres `23505` (unique violation) → friendly Thai error to staff. |
| Searchable | Yes, indexed by the scoped unique index. Search by full id at `/orders` → search bar. |

### Examples

| Input | Stored as | Result |
|---|---|---|
| `care-241` | `CARE-241` | OK |
| `0513-A` | `0513-A` | OK |
| `job 7` | rejected | Space not allowed |
| `(empty)` | rejected | Required |
| `THIS-IS-WAAAY-TOO-LONG-FOR-AN-ID-OVER-32` | rejected | >32 chars |

### Edge cases

- Customer asks for a re-print with the same id → `/orders` search returns the existing order; staff prints the existing receipt rather than creating a new order.
- Front-desk types same id twice in the same minute → second submit fails the pre-check; if both pass simultaneously, Postgres unique index rejects the slower insert and the form shows "Job ID ถูกใช้ในช่วงเวลาเดียวกัน — ลองใหม่".

---

## 4. Ezy Repair — auto rules

### Format

```
{BRANCH_SHORT_CODE}-{YYMMDD}-{SEQ}
```

| Token | Source | Example |
|---|---|---|
| `BRANCH_SHORT_CODE` | `public.branches.short_code` for the order's branch (e.g. `SLM`, `C24`, `BTS01`) | `SLM` |
| `YYMMDD` | `current_date` in the database server's timezone | `260513` |
| `SEQ` | 3-digit zero-padded sequence, resets daily, per branch + business_type | `001` |

### Examples

| Branch short_code | Date | Seq | Result |
|---|---|---|---|
| `SLM` | 2026-05-13 | 1 | `SLM-260513-001` |
| `SLM` | 2026-05-13 | 42 | `SLM-260513-042` |
| `BTS01` | 2026-05-13 | 1 | `BTS01-260513-001` |
| `C24` | 2026-05-14 | 1 | `C24-260514-001` (different day, fresh counter) |

### RPC

`public.generate_ezy_job_id(p_branch text) returns text` — accepts either `branches.code` (slug) OR `branches.id::text` (uuid as text). Falls back to upper-casing the input when no matching branch is found, so a misconfigured client still gets a predictable id.

Implementation: insert-on-conflict-do-update on `job_id_sequence`, returning the new `last_seq`. Postgres serialises the upsert per primary key, so two concurrent calls get consecutive sequence numbers without explicit locking.

### Daily reset

The sequence is keyed on `(branch_code, business_type, for_date)`. At 00:00 server-local the date rolls over and the next call starts at `001`. No cron job needed — the upsert handles it.

### Cross-branch concurrency

Two branches in two cities both submitting at the same wall-clock time → different `branch_code` primary keys → no contention. Each branch has its own counter.

### Cross-business-type concurrency

`SLM-260513-001` (Ezy) and a hypothetical Care U manual id `SLM-260513-001` (typed by the same shop's Care U side) are stored under **different** `business_type` values, so the scoped unique index allows both. This is deliberate — the receipts come from different cash drawers.

---

## 5. Uniqueness rules summary

| Combination | Unique? |
|---|---|
| Same `job_id` in same branch + same business_type | **No — rejected** |
| Same `job_id` in same branch + different business_type | Yes (Care U `CARE-001` and Ezy `CARE-001` coexist; not recommended but allowed) |
| Same `job_id` in different branches | Yes (`SLM-260513-001` and `C24-260513-001` can both exist) |
| Same generated Ezy `job_id` in same branch | Impossible — the RPC increments before returning |
| Reusing yesterday's `job_id` (Care U) | Yes — manual ids never expire |

---

## 6. Indexing strategy

| Index | Purpose |
|---|---|
| `orders_job_id_scoped_idx (branch_id, business_type, job_id) where job_id is not null` | Unique-constraint enforcement + lookup by id within a branch. |
| `orders_branch_id_idx (branch_id)` | Branch-scoped listings (`/orders`). |
| `orders_business_type_idx (business_type)` | Filters and dashboards. |
| `orders_created_at_idx (created_at desc)` | Default sort for the orders list and receipts. |
| `job_id_sequence` primary key `(branch_code, business_type, for_date)` | Atomic upsert + lookup of today's last sequence. |

Searching for a job id at `/orders`:
```sql
select * from public.orders
where job_id = $1
   or job_id like $1 || '%'
limit 50;
```
The index supports both equality and prefix scans.

---

## 7. Concurrency considerations

### Care U manual
- Pre-check + insert is racy by design. The Postgres unique index is the real arbiter. `lib/orderCreate.ts::resolveJobId` returns the friendly error from the pre-check; the insert path catches `23505` and surfaces "ถูกใช้ในช่วงเวลาเดียวkan — ลองใหม่".
- Two staff cannot insert the same id under the same branch + business_type — one wins, the other retries.

### Ezy auto
- `generate_ezy_job_id` is called inside the same transaction as the order insert (server-side via Supabase RPC). If the order insert fails after the RPC, the sequence row still advanced — that's an intentional gap, not a leak. Holes in the sequence are acceptable; replays are not.
- If two orders are submitted in the same millisecond, the `on conflict do update returning last_seq + 1` is serialised by Postgres at the row level. Both inserts get distinct sequences.

### Daily rollover races
- At 23:59:59.999 a request might be in flight that completes at 00:00:00.001. The RPC uses `current_date` at insert time, so the second order gets tomorrow's `001`. Acceptable — tonight's last receipt and tomorrow's first receipt have different dates.

### Audit
- Every order create writes `order_audit_log(action='created', after_value=job_id)` so any disputed id can be traced to its creator and timestamp.

---

## 8. UX rules

### On the form
- Section 5 ("Job ID") changes appearance based on `business_type`:
  - `care_u` → text input, required, 32-char limit, font-mono.
  - `ezy_repair` → read-only preview block showing the format pattern.
- The Ezy preview is **not** the final id — it's a hint. The real id appears on the receipt after save.

### On the receipt
- Show the job_id in monospaced font in the document header, paired with the order's short UUID for cross-reference.
- LINE OA / customer message templates include the job_id as the conversational reference.

### Searchability
- Front-staff searches by job_id at `/orders` → search field. Both partial and exact matches work.

---

## 9. Migration notes

The unique index was changed in `20260521_enterprise_foundation.sql`:
- Was: `orders_job_id_unique_idx on (job_id) where job_id is not null` — global uniqueness.
- Is now: `orders_job_id_scoped_idx on (branch_id, business_type, job_id) where job_id is not null` — scoped uniqueness.

**Risk:** if production data contained two rows with the same `job_id` in different branches/business_types, the old global-unique index would have rejected one of them. So the migration cannot find that pre-existing conflict. If you ever see duplicate Care U manual ids after migration, write a one-off cleanup script that audits the new index.

---

## 10. Future enhancements

| Capability | Plan |
|---|---|
| Per-branch prefix override | `system_settings.job_id_prefix` per branch (today: blank). |
| Customisable auto format | Settings table column to swap `YYMMDD` for `YYYYMMDD` or to drop the date. |
| QR on receipt | Encode `branch_code/job_id` so the customer can scan to track status. |
| Sequence gap detection | Daily report flagging sequences with gaps > 5 — useful for catching aborted intakes. |

---

**Last updated:** 2026-05-13 (commit 4805d3b)
