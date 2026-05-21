// Phase W2 - public.quote_requests -> central intake_drafts bridge.
//
// Pure server-only module. Called from /api/public/quote AFTER the
// quote_requests insert has succeeded. The bridge never throws into the
// public response: callers must wrap in try/catch and treat any failure
// as "log and continue" so the customer always sees the existing
// "ส่งคำขอเรียบร้อย" success card.
//
// Idempotency: the new public.intake_drafts.quote_request_id has a
// partial UNIQUE index (migration 20260520_03). A retried /quote POST
// that lands a fresh quote_requests row will produce a fresh draft; a
// duplicate write attempt against the SAME quote_request_id raises a
// Postgres 23505 which the bridge catches and treats as "already done"
// (returns the existing draft id).
//
// Identity rules carried over from Phase A:
//   - intake_drafts.branch_id stores the canonical branches.code slug
//     ("B01"), never a uuid. Resolved here via lib/branchResolve.ts so
//     bad input rejects the bridge instead of corrupting the row.
//   - manual_job_code is NULL for website drafts. The owner enters the
//     real bag-tag code from /admin/intake-drafts before pressing
//     "อนุมัติและสร้างใบงาน".
//   - draft_code uses a "W" prefix daily sequence so its source is
//     obvious in logs and the admin queue ("W260520-001").

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveBranchIdentity } from "@/lib/branchResolve";
import { buildDraftCode, draftDateStamp, parseDraftSeq } from "@/lib/draftCode";

export type QuoteToDraftInput = {
  admin: SupabaseClient;
  quoteRequestId: string;
  branchCode: string | null;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  urgency: "standard" | "urgent" | null;
  fulfilment: "in_store" | "pickup" | "delivery" | null;
  contactMethod: "phone" | "line" | "email" | "any" | null;
  email: string | null;
  /** Storage paths (NOT URLs) returned by /api/public/upload-url. */
  photos: string[];
  clientIp: string | null;
  clientUserAgent: string | null;
};

export type QuoteToDraftResult =
  | {
      ok: true;
      draftId: string;
      draftCode: string;
      mediaSaved: number;
      idempotent: boolean;
    }
  | { ok: false; reason: string };

function buildStaffNote(input: QuoteToDraftInput): string {
  const parts: string[] = ["[Website quote]"];
  if (input.notes) parts.push(input.notes);
  const meta: string[] = [];
  if (input.urgency)
    meta.push(`ความเร่งด่วน: ${input.urgency === "urgent" ? "ด่วน" : "ปกติ"}`);
  if (input.fulfilment) {
    const label =
      input.fulfilment === "delivery"
        ? "ส่งกลับถึงที่"
        : input.fulfilment === "pickup"
          ? "ให้ไปรับงาน"
          : "รับที่ร้าน";
    meta.push(`การรับงาน: ${label}`);
  }
  if (input.contactMethod && input.contactMethod !== "phone") {
    meta.push(`ติดต่อ: ${input.contactMethod}`);
  }
  if (input.email) meta.push(`อีเมล: ${input.email}`);
  if (meta.length > 0) parts.push(meta.join(" · "));
  return parts.join("\n");
}

/** Daily "W######-NNN" sequence lookup. Mirrors the mobile-intake route's
 *  draft_code generator but with a "W" prefix so the source is obvious. */
async function nextWebsiteDraftCode(
  admin: SupabaseClient
): Promise<{ stamp: string; seq: number; code: string }> {
  const stamp = draftDateStamp();
  const latest = await admin
    .from("intake_drafts")
    .select("draft_code")
    .like("draft_code", `W${stamp}-%`)
    .order("draft_code", { ascending: false })
    .limit(1);
  let seq = 1;
  const top = ((latest.data ?? []) as Array<{ draft_code: string }>)[0];
  if (top) {
    const parsed = parseDraftSeq(top.draft_code);
    if (parsed) seq = parsed + 1;
  }
  return { stamp, seq, code: buildDraftCode(stamp, seq, "W") };
}

export async function bridgeQuoteToIntakeDraft(
  input: QuoteToDraftInput
): Promise<QuoteToDraftResult> {
  const { admin } = input;

  // ---- Branch: must resolve to a real branches row -----------------
  // If the customer didn't pick one, fall back to the first active branch
  // (single-shop deployments today; multi-branch ops will add a per-route
  // policy later). Reject the bridge with a clear reason rather than
  // silently writing a NULL branch_id - the convert flow needs a real
  // branch to look up the customer uuid.
  let resolved = input.branchCode
    ? await resolveBranchIdentity(admin, input.branchCode)
    : null;
  if (!resolved) {
    const fallback = await admin
      .from("branches")
      .select("id, code")
      .eq("is_active", true)
      .order("code", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (fallback.data) {
      resolved = await resolveBranchIdentity(
        admin,
        String((fallback.data as { code: string }).code)
      );
    }
  }
  if (!resolved) {
    return { ok: false, reason: "no active branch to attach the draft" };
  }

  // ---- Idempotency probe -------------------------------------------
  // If a draft already exists for this quote_request_id (e.g. a retried
  // POST), return it without writing anything.
  const existing = await admin
    .from("intake_drafts")
    .select("id, draft_code")
    .eq("quote_request_id", input.quoteRequestId)
    .maybeSingle();
  if (existing.data) {
    const row = existing.data as { id: string; draft_code: string };
    return {
      ok: true,
      draftId: String(row.id),
      draftCode: String(row.draft_code),
      mediaSaved: 0,
      idempotent: true,
    };
  }

  // ---- Insert intake_drafts row (retry on draft_code collision only)
  let draftId: string | null = null;
  let draftCode = "";
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const next = await nextWebsiteDraftCode(admin);
    const ins = await admin
      .from("intake_drafts")
      .insert({
        draft_code: next.code,
        manual_job_code: null,
        branch_id: resolved.code,
        customer_name: input.customerName,
        customer_phone: input.customerPhone,
        staff_note: buildStaffNote(input),
        urgent_requested: input.urgency === "urgent",
        status: "NEW",
        ai_status: "pending",
        ai_needs_human_review: true,
        review_status: "needs_review",
        intake_source: "website",
        quote_request_id: input.quoteRequestId,
        client_ip: input.clientIp,
        client_user_agent: input.clientUserAgent,
      })
      .select("id")
      .single();
    if (!ins.error && ins.data) {
      draftId = String((ins.data as { id: string }).id);
      draftCode = next.code;
      break;
    }
    if (ins.error?.code === "23505") {
      // Disambiguate: did draft_code collide (bump seq + retry) or did
      // quote_request_id collide (race - another concurrent POST won;
      // fall back to the now-existing row).
      const msg = ins.error.message ?? "";
      if (/quote_request_id/i.test(msg)) {
        const after = await admin
          .from("intake_drafts")
          .select("id, draft_code")
          .eq("quote_request_id", input.quoteRequestId)
          .maybeSingle();
        if (after.data) {
          const row = after.data as { id: string; draft_code: string };
          return {
            ok: true,
            draftId: String(row.id),
            draftCode: String(row.draft_code),
            mediaSaved: 0,
            idempotent: true,
          };
        }
      }
      // draft_code collision - try the next sequence number.
      continue;
    }
    lastErr = ins.error?.message ?? "insert failed";
    break;
  }
  if (!draftId) {
    return { ok: false, reason: lastErr ?? "exhausted draft_code retries" };
  }

  // ---- Insert intake_draft_media rows ------------------------------
  // Schema's CHECK is image|video|audio - website photos are always
  // 'image'. Storage path is what /api/public/upload-url returned and
  // what quote_requests.photos already holds; the existing list route
  // signs read URLs uniformly via issueReadUrl.
  const paths = (input.photos ?? [])
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0);
  let mediaSaved = 0;
  if (paths.length > 0) {
    const rows = paths.map((p) => ({
      draft_id: draftId,
      media_type: "image",
      file_url: p,
    }));
    const mins = await admin.from("intake_draft_media").insert(rows);
    if (mins.error) {
      // The draft saved; missing media isn't fatal. Log and keep going so
      // the public response stays successful.
      console.warn(
        "[intake-bridge] media insert failed",
        mins.error.message
      );
    } else {
      mediaSaved = paths.length;
    }
  }

  return {
    ok: true,
    draftId,
    draftCode,
    mediaSaved,
    idempotent: false,
  };
}
