// Per-kind retry policy. Single source of truth for "how aggressively
// should the retry worker retry kind X, and after how long?". The worker
// reads this map; the admin UI surfaces it so operators understand the
// behaviour without diving into code.
//
// Operational philosophy:
//   • LINE pushes are visible to customers — fewer attempts, longer
//     cooldowns. We'd rather silently skip than spam.
//   • Sheet syncs are invisible to customers — more attempts, shorter
//     cooldowns. The accountant just wants the data to land.
//   • Manual-only kinds (admin presses a button) are NOT retried by the
//     worker — they show up in /admin/recovery for the operator to
//     resolve by hand.
//
// Server-friendly (no React imports).

import type { SyncFailureKind } from "@/lib/syncFailures";

export type RetryPolicy = {
  /** True when the worker will dispatch this kind. False = manual only. */
  autoRetry: boolean;
  /** Cap on attempts. Beyond this the worker marks `status='dead'` and
   *  stops touching the row. */
  maxAttempts: number;
  /** Minimum seconds between attempts on the same row. */
  cooldownSeconds: number;
  /** Operator-facing one-liner explaining the choice. */
  description: { th: string; en: string };
};

/** Default policy applied to kinds not explicitly listed. Conservative —
 *  short max, generous cooldown — so an unknown future kind doesn't
 *  accidentally hammer anything. */
const DEFAULT_POLICY: RetryPolicy = {
  autoRetry: false,
  maxAttempts: 3,
  cooldownSeconds: 300,
  description: {
    th: "ไม่ retry อัตโนมัติ — ปล่อยให้ admin จัดการเอง (ค่าเริ่มต้นปลอดภัย)",
    en: "Manual-only by default — safe fallback for unknown kinds.",
  },
};

export const RETRY_POLICIES: Record<SyncFailureKind, RetryPolicy> = {
  order_to_sheet: {
    autoRetry: true,
    maxAttempts: 10,
    cooldownSeconds: 30,
    description: {
      th: "ลูกค้าไม่เห็น — retry บ่อยได้ จนกว่าจะลงใน sheet สำเร็จ",
      en: "Invisible to customer — retry aggressively until the row lands.",
    },
  },
  line_send: {
    autoRetry: true,
    maxAttempts: 3,
    cooldownSeconds: 300,
    description: {
      th: "ลูกค้าเห็นทุกครั้ง — retry น้อยและรอห่างกัน 5 นาที กันสแปม",
      en: "Customer-visible — fewer attempts, 5 min cooldown to avoid spam.",
    },
  },
  receipt_rebuild: {
    autoRetry: true,
    maxAttempts: 3,
    cooldownSeconds: 60,
    description: {
      th: "เป็น read pure — retry ปานกลาง พอเช็คว่า DB ตอบกลับ",
      en: "Pure read — modest attempts just to confirm DB reachability.",
    },
  },
  pricing_to_sheet: {
    autoRetry: false,
    maxAttempts: 0,
    cooldownSeconds: 0,
    description: {
      th: "admin กดปุ่มเอง — worker จะไม่แตะ",
      en: "Admin-button snapshot — worker leaves it for manual retry.",
    },
  },
  customer_from_sheet: {
    autoRetry: false,
    maxAttempts: 0,
    cooldownSeconds: 0,
    description: {
      th: "admin import ลูกค้าจาก sheet — worker จะไม่แตะ",
      en: "Admin-driven customer import — manual only.",
    },
  },
  expense_from_sheet: {
    autoRetry: false,
    maxAttempts: 0,
    cooldownSeconds: 0,
    description: {
      th: "admin import expense — worker จะไม่แตะ",
      en: "Admin-driven expense import — manual only.",
    },
  },
  debug_to_sheet: {
    autoRetry: false,
    maxAttempts: 0,
    cooldownSeconds: 0,
    description: {
      th: "ใช้สำหรับตรวจสอบเท่านั้น — worker จะไม่ retry",
      en: "Diagnostic only — never retried by the worker.",
    },
  },
  reconcile_missing_sheet: {
    autoRetry: true,
    maxAttempts: 5,
    cooldownSeconds: 60,
    description: {
      th: "ใบงานยังไม่อยู่ใน Sheet — retry อัตโนมัติ (dedup ป้องกันแถวซ้ำ)",
      en: "Order missing from Sheet — auto-retry (dedup prevents dup rows).",
    },
  },
  reconcile_duplicate_sheet: {
    autoRetry: false,
    maxAttempts: 0,
    cooldownSeconds: 0,
    description: {
      th: "Sheet มีหลายแถวต่อ Job ID เดียว — admin ต้องตัดสินใจเลือกแถวที่ถูกต้อง",
      en: "Multiple Sheet rows for one Job ID — admin must pick the canonical row.",
    },
  },
  reconcile_orphan_link: {
    autoRetry: false,
    maxAttempts: 0,
    cooldownSeconds: 0,
    description: {
      th: "LINE follower ยังไม่ถูกผูกกับลูกค้านานเกินไป — admin จัดการที่ /admin/customer-line",
      en: "LINE follower stayed unlinked too long — admin pairs in /admin/customer-line.",
    },
  },
};

export function getRetryPolicy(kind: string): RetryPolicy {
  if ((RETRY_POLICIES as Record<string, RetryPolicy>)[kind]) {
    return (RETRY_POLICIES as Record<string, RetryPolicy>)[kind];
  }
  return DEFAULT_POLICY;
}

/** True if the kind has a real auto-retry path. False = manual-only. */
export function isAutoRetryable(kind: string): boolean {
  return getRetryPolicy(kind).autoRetry;
}
