// Phase C / L7 — LINE reply draft helpers. Pure.
//
// L7 lets an Owner/Admin reply to a customer's LINE from the
// /admin/intake-drafts page. Two pure pieces live here so they can be
// unit-tested and reused by both the API route and the admin UI:
//
//   • extractLineUserId() — the LINE OA bot (care-u-line-oa) records the
//     sender's LINE userId inside the draft's staff_note as a fixed line
//     "LINE userId: U…". This recovers it. No DB column, no migration —
//     the data is already there for every line_oa draft (F4 / F7).
//
//   • composeGuidedQuestionMessage() — turns the L6 Guided Question
//     Engine's drafted questions into one polite Thai message. The admin
//     still reviews / edits it and presses send (F3 — AI only drafts).
//
// Pure — no DB, no fetch, no React. Server- and client-safe.

/** LINE text message hard limit is 5000 chars; stay well under it. */
export const MAX_LINE_TEXT = 4900;

// The bot writes exactly: "\nLINE userId: U…" (see care-u-line-oa
// src/lib/intakeBridge.js::createLineImageDraft). A LINE user id is the
// letter U followed by 32 hex characters.
const LABELLED_USER_ID_RE = /LINE\s*userId\s*:\s*(U[0-9a-f]{32})/i;
// Defensive fallback — a bare U+32hex token anywhere in the note.
const BARE_USER_ID_RE = /\b(U[0-9a-f]{32})\b/i;

/**
 * Recover the customer's LINE userId from a draft's staff_note.
 * Returns null when the note carries no userId (e.g. a mobile-intake or
 * website draft, or a legacy LINE draft created before the bot recorded
 * it) — the caller must then surface a "can't reply via LINE" reason.
 */
export function extractLineUserId(
  staffNote: string | null | undefined
): string | null {
  if (!staffNote || typeof staffNote !== "string") return null;
  const labelled = staffNote.match(LABELLED_USER_ID_RE);
  if (labelled) return labelled[1];
  const bare = staffNote.match(BARE_USER_ID_RE);
  if (bare) return bare[1];
  return null;
}

/**
 * Compose the customer-facing LINE message from the L6 drafted questions.
 *
 * Returns "" when there are no questions — the caller should then not
 * offer a "send questions" action (there is nothing to ask).
 *
 * The message is a DRAFT: the admin edits it in the textarea on
 * /admin/intake-drafts before pressing send (F3).
 */
export function composeGuidedQuestionMessage(
  customerName: string | null | undefined,
  questions: string[] | null | undefined
): string {
  const cleanQuestions = (questions ?? [])
    .map((q) => (typeof q === "string" ? q.trim() : ""))
    .filter((q) => q.length > 0);
  if (cleanQuestions.length === 0) return "";

  const name =
    customerName && customerName.trim().length > 0
      ? " คุณ" + customerName.trim()
      : "";

  const lines: string[] = [];
  lines.push(
    "สวัสดีค่ะ" +
      name +
      " 🙏 ทางร้าน Care U ขอสอบถามข้อมูลเพิ่มเติมเล็กน้อย เพื่อประเมินราคางานซ่อมให้แม่นยำนะคะ"
  );
  lines.push("");
  cleanQuestions.forEach((q, i) => {
    lines.push(i + 1 + ". " + q);
  });
  lines.push("");
  lines.push("รบกวนพิมพ์ตอบกลับในแชตนี้ได้เลยค่ะ ขอบคุณค่ะ 🙏");

  const message = lines.join("\n");
  return message.length > MAX_LINE_TEXT
    ? message.slice(0, MAX_LINE_TEXT)
    : message;
}

/**
 * Validate an admin-typed reply before sending. Pure — the route calls
 * this so the UI and server agree on the rule.
 */
export function validateReplyText(
  text: string | null | undefined
): { ok: true; text: string } | { ok: false; reason: string } {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length === 0) {
    return { ok: false, reason: "ยังไม่มีข้อความที่จะส่ง" };
  }
  if (trimmed.length > MAX_LINE_TEXT) {
    return {
      ok: false,
      reason:
        "ข้อความยาวเกินไป (เกิน " + MAX_LINE_TEXT + " ตัวอักษร) — ขอให้สั้นลง",
    };
  }
  return { ok: true, text: trimmed };
}
