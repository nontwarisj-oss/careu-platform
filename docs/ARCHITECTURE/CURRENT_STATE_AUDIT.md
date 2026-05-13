# CareU OPS — Architecture Audit (Current State)

วันที่: 2026-05-13
ขอบเขต: `supabase/migrations/`, `package.json`, `next.config.ts`, โครงสร้าง `app/` และ `lib/`

---

## สรุปภาพรวม

| หัวข้อ | สถานะปัจจุบัน |
|---|---|
| Framework | Next.js 16.2.6 (App Router) + React 19 + TypeScript 5 + Tailwind 4 |
| Backend | Supabase (PostgREST + Auth ที่ยังไม่ได้เปิด) |
| Deploy | Vercel (ไม่มี `vercel.json`, ใช้ค่าเริ่มต้น) |
| Build | `next build` ผ่าน, ไม่มี `lint` / `test` script ใน `package.json` |
| Auth | ❌ ยังไม่ได้เปิดใช้ |
| RLS | ❌ ปิดทั้งหมด |
| Tests | ❌ ไม่มี |
| CI/CD | ❌ ไม่มี `.github/workflows`, ไม่มี `vercel.json` (พึ่ง Vercel auto-deploy เท่านั้น) |

---

## a. ตารางในฐานข้อมูล

| ตาราง | สร้างจาก migration | หมายเหตุ |
|---|---|---|
| `public.customers` | **ไม่อยู่ใน repo** (สร้างผ่าน Supabase UI หรือ migration ก่อนหน้า) | โค้ดอ้างถึงคอลัมน์ `id, branch_id, name, phone, email, address, notes, created_at, normalized_phone` |
| `public.branches` | **ไม่อยู่ใน repo** | โค้ด query `id` เพื่อใช้เป็น FK ของ `customers.branch_id` |
| `public.orders` | `20260512_orders.sql` | ตารางหลักของระบบ |
| `public.order_attachments` | `20260513_intake_extension.sql` | สำหรับรูป/วิดีโอ/ใบรับงาน (ยังไม่ได้ใช้งานจริง) |
| `public.branch_expenses` | `20260516_rbac_finance.sql` | ค่าใช้จ่ายระดับสาขา (ยังว่าง) |
| `public.roles` | `20260516_rbac_finance.sql` | seed แล้ว 7 บทบาท |
| `public.permissions` | `20260516_rbac_finance.sql` | ว่าง |
| `public.role_permissions` | `20260516_rbac_finance.sql` | ว่าง |
| `public.users` | `20260516_rbac_finance.sql` | มี `auth_user_id` รอ link กับ Supabase Auth |
| `public.user_branch_access` | `20260516_rbac_finance.sql` | ว่าง |

### คอลัมน์ที่เพิ่มเข้า `public.orders` แบบสะสม

| Migration | คอลัมน์ที่เพิ่ม |
|---|---|
| `20260513_intake_extension.sql` | `urgent`, `urgent_fee`, `notes`, `branch_id` |
| `20260514_smart_order_columns.sql` | `subtotal`, `discount`, `service_category`, `service_code`, `service_name`, `quantity`, `template_text`, `customer_type`, `promotion_code` |
| `20260515_payment_columns.sql` | `payment_status`, `payment_method`, `document_type` |
| `20260516_rbac_finance.sql` | `cost_estimate`, `labor_cost`, `material_cost` |
| `20260517_customer_phone_norm.sql` | (เพิ่มที่ `customers`) `normalized_phone` |

---

## b. RLS เปิดหรือปิด?

**ปิดทั้งหมด** — ทุก migration ใส่ `alter table … disable row level security;` อย่างชัดเจน

| ตาราง | RLS | คอมเมนต์ใน migration |
|---|---|---|
| `orders` | ❌ off | `-- RLS explicitly disabled per product requirement. TODO: re-enable once auth is wired.` |
| `order_attachments` | ❌ off | `-- RLS intentionally disabled for now — matches the rest of the schema.` |
| `branch_expenses` | ❌ off | `-- RLS intentionally OFF on every new table; policies land when real auth is wired.` |
| `roles`, `permissions`, `role_permissions`, `users`, `user_branch_access` | ❌ off | เหมือนกัน |

> **ความเสี่ยง:** anon key เข้าถึงข้อมูลลูกค้า/ออเดอร์/การเงินได้ทั้งหมด ต้องเปิด RLS + เพิ่ม policy ก่อน production จริง

---

## c. Audit Log (events table)?

**❌ ไม่มี** — ค้นหาคำว่า `audit`, `event_log`, `activity_log` ใน migrations ทั้งหมดไม่พบ

ไม่มีตาราง / trigger / function ใดที่บันทึก:
- ใครเป็นคน insert/update/delete
- เวลาที่เปลี่ยนสถานะ order
- การเปลี่ยน payment_status
- การล็อกอิน / การเข้าใช้งานหน้าใด

---

## d. branch_id ในตารางหลัก?

| ตาราง | มี branch_id? | ชนิด | บังคับใส่? |
|---|---|---|---|
| `customers` | ✅ | `uuid` (FK สู่ `branches.id`) | not null |
| `orders` | ✅ (จาก `20260513_intake_extension.sql`) | `text` (เก็บ `brandConfig.id` เช่น `"c24-thonburi-market"`) | nullable |
| `order_attachments` | ❌ (อ้างผ่าน `order_id`) | — | — |
| `branch_expenses` | ✅ | `text` | not null |
| `user_branch_access` | ✅ | `text` | not null |

> **ข้อขัดแย้งสำคัญ:** `customers.branch_id` เป็น `uuid` (อ้าง `public.branches.id`) แต่ `orders.branch_id` เป็น `text` (อ้าง `brandConfig.id` ใน frontend) — สองระบบ ID ที่ยังไม่ map กัน ต้องตัดสินใจ standardize

---

## e. State Machine ของ Order

มี **4 สถานะ** (เก็บใน `orders.status` เป็น `text` ไม่มี enum/constraint)

| Status | ความหมาย | แก้ได้จาก UI? |
|---|---|---|
| `pending` | รอดำเนิน (ค่าเริ่มต้น) | ✅ |
| `in-progress` | กำลังซ่อม | ✅ |
| `completed` | เสร็จสิ้น | ✅ |
| `ready-for-pickup` | พร้อมรับ (legacy/display only) | ⚠️ แสดงผลได้ แต่ในตัวแก้สถานะปัจจุบันไม่ list ให้เลือก |

ระบบไม่มี:
- DB-level `CHECK constraint` หรือ enum type
- Transition rules (เช่น ห้ามกลับจาก `completed` → `pending`)
- Audit ของการเปลี่ยน status

---

## f. Authentication

**❌ ยังไม่ได้เปิดใช้**

- ไม่มี middleware ใน `app/` (ไม่มี `middleware.ts`)
- ไม่ใช้ `@supabase/auth-helpers-*` / `@supabase/ssr`
- `lib/supabase.ts` สร้าง client ด้วย anon key เท่านั้น ไม่มี session
- `lib/roleContext.tsx` ใช้ localStorage (`careu.role`) เป็น preview mode ทุกคนเริ่มเป็น `executive`
- ตาราง `users` รอ FK กับ `auth.users` (มีคอลัมน์ `auth_user_id` เตรียมไว้แล้ว)

---

## g. การใช้ AI

**❌ ไม่มีการใช้ AI ที่ runtime** ใน production codebase

- ไม่มี dependency `openai`, `anthropic`, `@ai-sdk/*`, `google-genai`, ฯลฯ ใน `package.json`
- ไม่มี route ใดเรียก LLM
- การ "auto-fill description" บน intake ใช้ template ภาษาไทยจาก `lib/pricing.ts` (constant) ไม่ใช่ LLM

---

## h. LINE OA

**🟡 มีโครงสร้างพร้อม แต่ยังไม่ได้ส่งจริง**

| สิ่งที่มี | สถานะ |
|---|---|
| `lib/lineOA.ts` | wrapper เรียก `/api/line/send` (client-side) |
| `app/api/line/send/route.ts` | Node runtime route, อ่าน `LINE_CHANNEL_ACCESS_TOKEN` ตอน runtime |
| `.env.example` | มี `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `LINE_OA_ID` (server-only) |
| ปุ่ม "ส่ง Line OA" บนเอกสาร | เรียก stub และโชว์ toast "ยังไม่ได้ตั้งค่า" |
| Real push ไปยัง `api.line.me/v2/bot/message/push` | ❌ comment ไว้ — รอ webhook follow-flow เก็บ `line_user_id` ของลูกค้าก่อน |
| Webhook (LINE follow / message) | ❌ ยังไม่มี |

---

## i. Test

**❌ ไม่มี**

- ไม่มี `test`, `vitest`, `jest`, `playwright` ใน scripts หรือ dependencies
- ไม่มีโฟลเดอร์ `__tests__`, `tests`, `e2e`
- ไม่มี snapshot / contract test ของ Supabase queries
- ระดับ verification ที่ใช้คือ `pnpm run build` (TypeScript + Next.js build) เท่านั้น

---

## j. CI/CD

**❌ ไม่มี pipeline ที่ตั้งใจสร้าง**

| สิ่งที่มี | สถานะ |
|---|---|
| `.github/workflows/` | ❌ ไม่มี |
| `vercel.json` | ❌ ไม่มี |
| Auto-deploy บน push to `main` | ✅ ใช้ Vercel default (commit ก่อนหน้า: `60c3751`) |
| Migration runner อัตโนมัติ | ❌ — CTO ต้อง run SQL เองใน Supabase SQL editor |
| Branch protection / required checks | ❌ |

---

## โครงสร้าง `app/` และ `lib/` โดยย่อ

```
app/
├─ layout.tsx              # LanguageProvider > RoleProvider > BranchProvider
├─ page.tsx                # Layered dashboard (5 views ตาม role)
├─ globals.css             # @page A4 print rules
├─ customers/page.tsx      # CRM + sync + import
├─ intake/page.tsx         # Mobile-first walk-in intake (ใช้ SmartOrderForm)
├─ orders/
│  ├─ page.tsx             # SmartOrderForm + table + filters + detail modal
│  └─ [id]/document/page.tsx  # ใบรับงาน/เสนอราคา/ชำระเงิน (printable + save-as-image)
├─ invoices/page.tsx       # Receipt cards (legacy, ทับซ้อนกับ document page)
└─ api/
   ├─ line/send/route.ts   # LINE OA placeholder
   └─ sync-customers/route.ts  # ดึง Google Sheet Data_Center

lib/
├─ supabase.ts             # createClient(anon)
├─ analytics.ts            # aggregations per branch/service/segment
├─ branchContext.tsx       # global branch state (localStorage)
├─ brandConfig.ts          # 2 brands × 1 branch each (static)
├─ customerImport.ts       # CSV parser + dedup insert
├─ customerMessage.ts      # text generator สำหรับ clipboard/LINE
├─ languageContext.tsx     # th/en switcher
├─ lineOA.ts               # client wrapper สำหรับ /api/line/send
├─ orderCreate.ts          # smart insert with progressive fallback
├─ phone.ts                # canonical Thai phone normalization
├─ pricing.ts              # service catalog + promotions + customer types
├─ roleContext.tsx         # global role state (localStorage)
├─ roles.ts                # 7 roles + permission helpers
├─ translations.ts         # th/en strings
└─ utils.ts                # formatCurrency, formatDate, formatPhoneNumber
```

---

## ความเสี่ยงและสิ่งที่ต้องทำต่อ (เรียงตามความเร่งด่วน)

1. **เปิด RLS + ทำ policy** ก่อน production จริง — ปัจจุบัน anon key อ่าน/เขียนได้ทุกตาราง
2. **เปิด Supabase Auth** + เชื่อม `public.users.auth_user_id` กับ `auth.users` — role context จะได้เลิกใช้ localStorage
3. **Audit log table** สำหรับเหตุการณ์สำคัญ (status change, payment update, sync) — ยังไม่มีเลย
4. **Standardize branch ID** — `customers.branch_id` (uuid) vs `orders.branch_id` (text) ต้อง map กัน
5. **Tests** — อย่างน้อย smoke test ของ `createSmartOrder` 3-tier fallback และ phone normalization
6. **CI** — GitHub Action ที่ run `pnpm build` + lint + (อนาคต) test ก่อน merge to main
7. **LINE Follow webhook** — เพื่อเก็บ `customers.line_user_id` แล้วเปิด push จริง
8. **Customer duplicate merge tool** + UNIQUE(`normalized_phone`) — มี normalized_phone แล้ว แต่ legacy data ยังซ้ำอยู่
