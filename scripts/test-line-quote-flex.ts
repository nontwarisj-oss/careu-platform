// Phase C / L8 — unit tests for lib/lineQuoteFlex.ts.
//
// Pure: no DB, no network. Compile + run:
//   npx tsc lib/lineQuoteFlex.ts scripts/test-line-quote-flex.ts \
//     --outDir /tmp/l8 --module commonjs --moduleResolution node \
//     --target es2020 --esModuleInterop --skipLibCheck --strict
//   node /tmp/l8/scripts/test-line-quote-flex.js

import {
  buildQuoteFlex,
  validateQuoteFlexInput,
  type QuoteFlexInput,
} from "../lib/lineQuoteFlex";

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

console.log("=== L8 LINE quote Flex — tests ===\n");

const base: QuoteFlexInput = {
  shopName: "Care U",
  serviceText: "ตัดขากางเกงยีนส์ (เก็บชายเดิม)",
  price: 250,
};

// --- 1) validate — happy path ------------------------------------------
check("validate — valid input → ok", validateQuoteFlexInput(base).ok === true);

// --- 2) validate — missing shop name -----------------------------------
check(
  "validate — empty shopName → fail",
  validateQuoteFlexInput({ ...base, shopName: "  " }).ok === false
);

// --- 3) validate — missing service text --------------------------------
check(
  "validate — empty serviceText → fail",
  validateQuoteFlexInput({ ...base, serviceText: "" }).ok === false
);

// --- 4) validate — bad price -------------------------------------------
check(
  "validate — NaN price → fail",
  validateQuoteFlexInput({ ...base, price: Number.NaN }).ok === false
);
check(
  "validate — negative price → fail",
  validateQuoteFlexInput({ ...base, price: -10 }).ok === false
);
check(
  "validate — price 0 → ok (free quote allowed)",
  validateQuoteFlexInput({ ...base, price: 0 }).ok === true
);

// --- 5) build — message shape ------------------------------------------
const m1 = buildQuoteFlex(base);
check("build — type is 'flex'", m1.type === "flex");
check(
  "build — contents is a bubble",
  (m1.contents as { type?: string }).type === "bubble"
);
check(
  "build — has header / body / footer",
  Boolean(m1.contents.header) &&
    Boolean(m1.contents.body) &&
    Boolean(m1.contents.footer)
);

// --- 6) build — altText carries the key facts --------------------------
check("build — altText has shop name", m1.altText.includes("Care U"));
check(
  "build — altText has the service",
  m1.altText.includes("ตัดขากางเกงยีนส์")
);
check("build — altText has the price", m1.altText.includes("250 บาท"));

// --- 7) build — price formatting (thousands separator) -----------------
const m2 = buildQuoteFlex({ ...base, price: 1500 });
check(
  "build — 1500 renders as '1,500 บาท' somewhere in the bubble",
  JSON.stringify(m2.contents).includes("1,500 บาท")
);

// --- 8) build — default approver is เจ้าของร้าน -------------------------
check(
  "build — default approvedBy = เจ้าของร้าน",
  JSON.stringify(m1.contents).includes("เจ้าของร้าน")
);

// --- 9) build — footer button count: no phone → 1 button ---------------
const footer1 = m1.contents.footer as { contents: unknown[] };
check(
  "build — no shopPhone → 1 footer button (confirm only)",
  footer1.contents.length === 1
);

// --- 10) build — with phone → 2 buttons + a tel: URI -------------------
const m3 = buildQuoteFlex({ ...base, shopPhone: "094-978-2624" });
const footer3 = m3.contents.footer as { contents: unknown[] };
check(
  "build — with shopPhone → 2 footer buttons",
  footer3.contents.length === 2
);
check(
  "build — phone button uses tel: with digits only",
  JSON.stringify(m3.contents).includes("tel:0949782624")
);

// --- 11) build — branch + jobCode rows appear when supplied ------------
const m4 = buildQuoteFlex({
  ...base,
  branchText: "ตลาดสดธนบุรี",
  jobCode: "36AB",
});
check(
  "build — branch row shown",
  JSON.stringify(m4.contents).includes("ตลาดสดธนบุรี")
);
check("build — jobCode row shown", JSON.stringify(m4.contents).includes("36AB"));

// --- 12) build — validity note shown when supplied ---------------------
const m5 = buildQuoteFlex({ ...base, validityText: "ราคานี้ยืนยัน 7 วัน" });
check(
  "build — validity text shown",
  JSON.stringify(m5.contents).includes("ราคานี้ยืนยัน 7 วัน")
);

// --- 13) build — confirm button always present -------------------------
check(
  "build — confirm button label present",
  JSON.stringify(m1.contents).includes("ยืนยันรับงาน")
);

console.log("\n=== " + pass + " passed, " + fail + " failed ===");
if (fail > 0) {
  process.exitCode = 1;
}
