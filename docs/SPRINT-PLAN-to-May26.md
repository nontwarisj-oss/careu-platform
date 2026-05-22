# แผนสปรินต์ปิดงานก่อน 26 พ.ค. 2569 — Care U / Ezy Repair OPS Platform

จัดทำ 22 พ.ค. 2569 · เส้นตาย 26 พ.ค. (ตั้งเอง — ยืดได้ถ้าจำเป็น) · เวลาทำงาน ~2–3 ชม./วัน

---

## 1. เป้าหมายสปรินต์

ให้ **เว็บ `/quote`** และ **LINE OA** รับงานจากลูกค้าเข้าสู่ระบบกลาง (`intake_drafts`) ได้จริง **ทั้งสองช่องทาง** ภายใน 22–26 พ.ค.

หลัก: ทำของพื้นฐานให้ "รับงานได้จริง" ครบ ดีกว่าทำหลายอย่างครึ่ง ๆ — ถ้าฝั่ง LINE สลิป 1–2 วัน รับได้ "ใช้งานได้จริง" สำคัญกว่า "ทันวันที่"

---

## 2. หลักการที่คงไว้ (ตาม Framework เดิม)

ทุกช่องทาง → สร้าง `intake_drafts` ก่อน · AI = suggest เท่านั้น · Owner/Admin ตรวจก่อน convert · `payment_status` เริ่ม `unpaid` · ไม่สร้าง Order อัตโนมัติจากเว็บ/LINE/AI · ไม่ปน scope เว็บ/LINE ใน commit เดียว

---

## 3. ขอบเขต — ทำในสปรินต์นี้

**เว็บไซต์**
- W-A — ยืนยัน flow `/quote` ครบวง: ส่งคำขอ → `quote_requests` → `intake_drafts` → `intake_draft_media` → `/admin/intake-drafts` เห็นรูปจริง
- W-B — Pricing Source Alignment: `/services` และ `/quote` ดึงราคาจาก Service Price Master แหล่งเดียว (แก้บั๊กราคาเว็บไม่ตรง master)

**LINE OA**
- L-M — ชุด migration LINE OA: สร้าง `line_follow_events`, `customer_line_links`, `line_delivery_log`, `line_message_events` (ปัจจุบันยังไม่มีใน DB จริง)
- L-3 — webhook ดาวน์โหลด media จาก LINE content API → Supabase Storage (server-side)
- L-4 — สร้าง/อัปเดต `intake_drafts` (`intake_source='line_oa'`) + `intake_draft_media` → ขึ้นในคิว Admin

**งานบ้าน**
- H — commit เก็บกวาด working tree (~19 ไฟล์ line-ending churn) ให้สะอาดก่อนเริ่ม

---

## 4. ขอบเขต — เลื่อนไปหลัง 26 พ.ค. (ระบุชัด)

AI Service Router (P3) · AI Guided Questions (P4) · Website tracking W4–W9 · LINE L5–L9 (AI router, guided reply, owner reply-to-LINE, Flex quote, monitoring) · Admin UX polish (P7) · Login/PIN (P8) · Dashboard/Reports (P9) · Production hardening (P10)

เหตุผล: รวมแล้วเป็นงานหลายสัปดาห์ ทำใน 4 วันแบบมีคุณภาพไม่ได้ — สปรินต์นี้ปิด "รับงานได้จริง" ก่อน ที่เหลือทำต่อเป็นลำดับหลัง 26

---

## 5. แผนรายวัน (ยืดหยุ่นได้)

| วัน | งาน |
|---|---|
| Day 1 — ศ. 22 (ที่เหลือ) | H commit เก็บกวาด · W-A ยืนยัน flow `/quote` · เริ่ม audit ราคา |
| Day 2 — ส. 23 | W-B Pricing Alignment ให้จบ · deploy · ทดสอบ → **ปิดงานเว็บ** |
| Day 3 — อา. 24 | L-M apply migration · เขียนโค้ด L-3 + L-4 (webhook media + draft) |
| Day 4 — จ. 25 | LINE deploy · ตั้ง env + webhook URL · ทดสอบ end-to-end |
| 26 พ.ค. | buffer · UAT ทั้งสองช่องทาง |

---

## 6. สิ่งที่ต้องการจากคุณเอ๋ (ตัวแปรสำคัญฝั่ง LINE)

1. **LINE OA channel** — careu-platform จะใช้ channel ไหน? ตัวเดียวกับบอท Ezy Repair เดิม หรือ channel ใหม่ — สำคัญมาก เพราะ 1 channel ตั้ง Webhook URL ได้ที่เดียว ถ้าใช้ตัวเดิมจะชนกับบอท Ezy Repair
2. **LINE channel access token + channel secret** → ตั้งเป็น env var บน Vercel (ผมบอกชื่อตัวแปรให้)
3. ตั้ง **Webhook URL** ใน LINE Developer Console
4. รัน SQL migration บน Supabase (ผมเตรียม SQL ให้ครบ)
5. deploy ขึ้น Vercel (ผมเตรียมโค้ด + คำสั่งให้)

---

## 7. ความเสี่ยง (พูดตรง)

- **เว็บ — เสี่ยงต่ำ** ใกล้เสร็จแล้ว เหลือ verify + แก้ราคา งานบ่งชี้ชัด
- **LINE — เสี่ยงปานกลาง** L-M/L-3/L-4 เป็นงานใหม่จริง และขึ้นกับ channel/token/webhook ที่คุณเอ๋ต้องจัดเตรียม ถ้าติดเรื่อง channel อาจสลิป 1–2 วัน — เส้นตายตั้งเอง ยืดได้
- LINE OA ทำบน branch `feature/line-oa-intake` แยก เริ่มหลังงานเว็บ commit ลง main เรียบร้อย — กัน scope ปนกัน

---

## 8. สถานะตั้งต้น (ยืนยันแล้ว 22 พ.ค.)

เสร็จแล้ว: บั๊กอัปโหลด `/quote` (W3.10/W3.11) · error 400 (migration 20260533) · Phase A/B/W2 · ตาราง `intake_drafts`+`intake_draft_media`+`quote_requests` พร้อม · `intake_source`/`quote_request_id` มีครบ
