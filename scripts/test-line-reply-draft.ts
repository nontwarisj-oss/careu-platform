// Phase C / L7 — unit tests for lib/lineReplyDraft.ts.
//
// Pure: no DB, no network. Compile + run:
//   npx tsc lib/lineReplyDraft.ts scripts/test-line-reply-draft.ts \
//     --outDir /tmp/l7 --module commonjs --moduleResolution node \
//     --target es2020 --esModuleInterop --skipLibCheck --strict
//   node /tmp/l7/scripts/test-line-reply-draft.js

import {
  extractLineUserId,
  composeGuidedQuestionMessage,
  validateReplyText,
  MAX_LINE_TEXT,
} from "../lib/lineReplyDraft";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log("  PASS  " + name);
  } else {
    fail += 1;
    console.log("  FAIL  " + name + (detail ? " — " + detail : ""));
  }
}

console.log("=== L7 LINE reply draft — tests ===\n");

// A valid LINE user id: U + 32 hex chars.
const UID = "U0123456789abcdef0123456789abcdef";

// --- 1) extractLineUserId — the exact bot format ------------------------
// care-u-line-oa intakeBridge.js writes this into staff_note.
const botNote =
  "งานเข้าจาก LINE OA (Care U) — สมชาย\nLINE userId: " + UID;
check(
  "extract — bot staff_note format",
  extractLineUserId(botNote) === UID,
  String(extractLineUserId(botNote))
);

// --- 2) extractLineUserId — no userId present ---------------------------
check(
  "extract — note without userId → null",
  extractLineUserId("งานเข้าจากหน้าร้าน — ซ่อมซิป") === null
);

// --- 3) extractLineUserId — null / empty / undefined --------------------
check("extract — null → null", extractLineUserId(null) === null);
check("extract — undefined → null", extractLineUserId(undefined) === null);
check("extract — empty string → null", extractLineUserId("") === null);

// --- 4) extractLineUserId — uppercase-hex id still matches --------------
const upperNote = "LINE userId: U0123456789ABCDEF0123456789ABCDEF";
check(
  "extract — uppercase hex id matches",
  extractLineUserId(upperNote) === "U0123456789ABCDEF0123456789ABCDEF"
);

// --- 5) extractLineUserId — label spacing variations --------------------
check(
  "extract — 'LINEuserId:' tight spacing",
  extractLineUserId("LINEuserId:" + UID) === UID
);

// --- 6) extractLineUserId — bare token fallback -------------------------
check(
  "extract — bare U+32hex token fallback",
  extractLineUserId("ลูกค้า " + UID + " ส่งรูปมา") === UID
);

// --- 7) extractLineUserId — wrong length is rejected --------------------
check(
  "extract — U + 30 hex (too short) → null",
  extractLineUserId("LINE userId: U0123456789abcdef0123456789abcd") === null
);

// --- 8) composeGuidedQuestionMessage — with name + questions ------------
const msg1 = composeGuidedQuestionMessage("สมชาย", [
  "ขอทราบประเภทของผ้าค่ะ",
  "ซิปยาวกี่นิ้วคะ",
]);
check("compose — greets the named customer", msg1.includes("คุณสมชาย"));
check("compose — numbers question 1", msg1.includes("1. ขอทราบประเภทของผ้าค่ะ"));
check("compose — numbers question 2", msg1.includes("2. ซิปยาวกี่นิ้วคะ"));
check("compose — has a closing line", msg1.includes("ขอบคุณค่ะ"));
check("compose — mentions the shop name", msg1.includes("Care U"));

// --- 9) composeGuidedQuestionMessage — no customer name -----------------
const msg2 = composeGuidedQuestionMessage(null, ["ส่งรูปเพิ่มได้ไหมคะ"]);
check(
  "compose — no name → no ' คุณ' name prefix",
  !msg2.includes(" คุณ")
);
check(
  "compose — no name → greeting starts without a name",
  msg2.startsWith("สวัสดีค่ะ 🙏")
);

// --- 10) composeGuidedQuestionMessage — empty / null questions ----------
check(
  "compose — empty questions → empty string",
  composeGuidedQuestionMessage("สมชาย", []) === ""
);
check(
  "compose — null questions → empty string",
  composeGuidedQuestionMessage("สมชาย", null) === ""
);

// --- 11) composeGuidedQuestionMessage — whitespace-only filtered --------
const msg3 = composeGuidedQuestionMessage("ก", ["  ", "คำถามจริง", ""]);
check(
  "compose — blank questions dropped, only real one numbered",
  msg3.includes("1. คำถามจริง") && !msg3.includes("2.")
);

// --- 12) validateReplyText ---------------------------------------------
check(
  "validate — empty → ok:false",
  validateReplyText("").ok === false
);
check(
  "validate — whitespace only → ok:false",
  validateReplyText("   \n  ").ok === false
);
const v = validateReplyText("  สวัสดีค่ะ  ");
check(
  "validate — trims and returns ok:true",
  v.ok === true && v.ok && v.text === "สวัสดีค่ะ"
);
check(
  "validate — over MAX_LINE_TEXT → ok:false",
  validateReplyText("ก".repeat(MAX_LINE_TEXT + 1)).ok === false
);

// --- 13) round-trip: composed message validates -------------------------
const composed = composeGuidedQuestionMessage("ลูกค้า", ["คำถาม"]);
check("round-trip — composed message passes validateReplyText", validateReplyText(composed).ok === true);

console.log("\n=== " + pass + " passed, " + fail + " failed ===");
if (fail > 0) {
  process.exitCode = 1;
}
