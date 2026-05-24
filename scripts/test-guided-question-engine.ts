// Phase C / L6 — unit tests for lib/guidedQuestionEngine.ts.
//
// Pure: no DB, no network. Compile + run:
//   npx tsc lib/knowledgeModules.ts lib/guidedQuestionEngine.ts \
//     scripts/test-guided-question-engine.ts --outDir /tmp/l6 \
//     --module commonjs --moduleResolution node --target es2020 \
//     --esModuleInterop --skipLibCheck
//   node /tmp/l6/scripts/test-guided-question-engine.js

import {
  buildChecklist,
  renderAdminChecklist,
  type DraftSignals,
} from "../lib/guidedQuestionEngine";
import {
  SERVICE_DOMAINS,
  getModule,
} from "../lib/knowledgeModules";

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

console.log("=== L6 Guided Question Engine — tests ===\n");

// --- 1) Fresh clothing draft: every slot missing -------------------------
const freshClothing: DraftSignals = { hasText: true, photoCount: 1 };
const c1 = buildChecklist("clothing_repair", freshClothing);
check(
  "fresh clothing — requiredComplete is false",
  c1.requiredComplete === false
);
check(
  "fresh clothing — have lists text + 1 photo",
  c1.have.includes("คำอธิบายจากลูกค้า") && c1.have.includes("รูป 1 รูป")
);
check(
  "fresh clothing — required field garment_type is in missing",
  c1.missing.some((m) => m.key === "garment_type" && m.required)
);
check(
  "fresh clothing — required media repair_closeup is in missing",
  c1.missing.some((m) => m.key === "repair_closeup" && m.kind === "media")
);
check(
  "fresh clothing — optional slot fabric_label is in missing",
  c1.missing.some((m) => m.key === "fabric_label" && m.required === false)
);
check(
  "fresh clothing — customerQuestions not empty",
  c1.customerQuestions.length > 0
);
check(
  "fresh clothing — required items sorted before optional",
  (() => {
    const firstOptional = c1.missing.findIndex((m) => !m.required);
    const lastRequired = c1.missing
      .map((m) => m.required)
      .lastIndexOf(true);
    return firstOptional === -1 || lastRequired < firstOptional;
  })()
);

// --- 2) Re-ask suppression: filled slots drop out ------------------------
const partialClothing: DraftSignals = {
  hasText: true,
  photoCount: 2,
  filledFields: ["target_length"],
  filledMedia: ["repair_closeup"],
};
const c2 = buildChecklist("clothing_repair", partialClothing);
check(
  "partial clothing — filled field target_length not in missing",
  !c2.missing.some((m) => m.key === "target_length")
);
check(
  "partial clothing — filled media repair_closeup not in missing",
  !c2.missing.some((m) => m.key === "repair_closeup")
);
check(
  "partial clothing — repair_closeup question NOT re-asked",
  !c2.customerQuestions.some((q) => q.includes("จุดที่ต้องการซ่อม"))
);
check(
  "partial clothing — fewer missing items than fresh",
  c2.missing.length < c1.missing.length
);

// --- 3) requiredComplete when all required slots filled ------------------
const wbMod = getModule("watch_battery");
const completeWatch: DraftSignals = {
  hasText: true,
  photoCount: 2,
  filledFields: wbMod.requiredFields.map((f) => f.key),
  filledMedia: wbMod.requiredMedia.map((m) => m.key),
};
const c3 = buildChecklist("watch_battery", completeWatch);
check(
  "watch_battery — requiredComplete true when all required filled",
  c3.requiredComplete === true
);
check(
  "watch_battery — no required item left in missing",
  !c3.missing.some((m) => m.required)
);

// --- 4) All 7 domains produce a usable checklist -------------------------
let allDomainsOk = true;
for (const d of SERVICE_DOMAINS) {
  const cl = buildChecklist(d, { hasText: false, photoCount: 0 });
  if (
    cl.serviceDomain !== d ||
    cl.displayNameTh.length === 0 ||
    cl.missing.length === 0 ||
    cl.requiredComplete !== false
  ) {
    allDomainsOk = false;
    console.log("    (domain " + d + " produced an unexpected checklist)");
  }
}
check("all 7 domains — fresh draft yields a non-empty checklist", allDomainsOk);

// --- 5) renderAdminChecklist output --------------------------------------
const rendered = renderAdminChecklist(c1, {
  draftCode: "L260524-TEST1",
  confidence: 0.86,
});
check(
  "render — contains the AI สั่งงาน header + draft code",
  rendered.includes("AI สั่งงาน Intake") && rendered.includes("L260524-TEST1")
);
check("render — contains a ยังขาด line", rendered.includes("ยังขาด"));
check("render — contains มั่นใจ 0.86", rendered.includes("มั่นใจ 0.86"));

const renderedEmpty = renderAdminChecklist(
  buildChecklist("ezy_other", { hasText: false, photoCount: 0 })
);
check(
  "render — empty draft shows ✅ มีแล้ว: —",
  renderedEmpty.includes("✅ มีแล้ว: —")
);

// --- 6) requiredComplete render shows the ready line ---------------------
check(
  "render — all-required-filled shows ✔️ ข้อมูลครบ",
  renderAdminChecklist(c3).includes("ข้อมูลครบ")
);

// --- Invariants -----------------------------------------------------------
console.log("\n--- invariants ---");
check(
  "customerQuestions are unique",
  (() => {
    const q = c1.customerQuestions;
    return new Set(q).size === q.length;
  })()
);
check(
  "every missing item has a non-empty labelTh",
  SERVICE_DOMAINS.every((d) =>
    buildChecklist(d, { hasText: false, photoCount: 0 }).missing.every(
      (m) => m.labelTh.length > 0
    )
  )
);
check(
  "every customerQuestion maps to a missing item question",
  c1.customerQuestions.every((q) =>
    c1.missing.some((m) => m.questionTh === q)
  )
);

console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
process.exit(fail === 0 ? 0 : 1);
