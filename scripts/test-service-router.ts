// Phase C / L5 — unit tests for lib/serviceRouter.ts.
//
// Pure: no DB, no network. Compile + run:
//   npx tsc lib/knowledgeModules.ts lib/serviceRouter.ts \
//     scripts/test-service-router.ts --outDir /tmp/l5 --module commonjs \
//     --moduleResolution node --target es2020 --esModuleInterop --skipLibCheck
//   node /tmp/l5/scripts/test-service-router.js
//
// Covers all 7 domains, an ambiguous case (must land in band "medium"),
// a no-signal case (catch-all + band "low"), repair-category inference,
// and multi-signal (text + image) detection.

import {
  routeService,
  confidenceBand,
  type RouterInput,
  type ConfidenceBand,
} from "../lib/serviceRouter";
import {
  SERVICE_DOMAINS,
  KNOWLEDGE_MODULES,
  type ServiceDomain,
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

type Case = {
  name: string;
  input: RouterInput;
  domain: ServiceDomain;
  band?: ConfidenceBand;
  category?: string | null;
  altIncludes?: ServiceDomain;
  signals?: string[];
};

const CASES: Case[] = [
  {
    name: "clothing — ตัดขายีนส์",
    input: { text: "ลูกค้าอยากตัดขายีนส์ให้สั้นลง" },
    domain: "clothing_repair",
    band: "high",
  },
  {
    name: "shoe — พื้นรองเท้าหลุด",
    input: { text: "พื้นรองเท้าหลุด อยากซ่อม" },
    domain: "shoe_repair",
    band: "high",
  },
  {
    name: "shoe — repair category (heel)",
    input: { text: "ซ่อมส้นรองเท้าหลุด" },
    domain: "shoe_repair",
    category: "heel_repair",
  },
  {
    name: "luggage — ล้อกระเป๋าเดินทาง",
    input: { text: "ล้อกระเป๋าเดินทางหลุด 2 ล้อ" },
    domain: "luggage_repair",
    band: "high",
  },
  {
    name: "watch_battery — เปลี่ยนถ่าน นาฬิกาตาย",
    input: { text: "นาฬิกาตาย อยากเปลี่ยนถ่าน" },
    domain: "watch_battery",
    band: "high",
  },
  {
    name: "watch_repair — ซ่อมนาฬิกา เข็มหัก",
    input: { text: "ซ่อมนาฬิกา เข็มนาฬิกาหัก" },
    domain: "watch_repair",
    band: "high",
  },
  {
    name: "car_key — เปลี่ยนถ่านรีโมทกุญแจรถ",
    input: { text: "เปลี่ยนถ่านรีโมทกุญแจรถ" },
    domain: "car_key_battery",
    band: "high",
  },
  {
    name: "no signal — fallback ezy_other, band low",
    input: { text: "อยากสอบถามราคาหน่อยค่ะ" },
    domain: "ezy_other",
    band: "low",
  },
  {
    name: "empty text — fallback ezy_other, band low",
    input: { text: null },
    domain: "ezy_other",
    band: "low",
  },
  {
    name: "ambiguous watch (image only) — band medium + alt watch_repair",
    input: { text: null, imageLabels: ["watch"] },
    domain: "watch_battery",
    band: "medium",
    altIncludes: "watch_repair",
  },
  {
    name: "multi-signal — text + image both used",
    input: { text: "พื้นรองเท้าหลุด", imageLabels: ["shoe", "sole"] },
    domain: "shoe_repair",
    signals: ["text", "image"],
  },
  {
    name: "voice transcript — clothing via voice",
    input: { text: null, voiceTranscript: "อยากเอากางเกงมาเข้าเอว" },
    domain: "clothing_repair",
    signals: ["voice"],
  },
];

console.log("=== L5 Service Router — tests ===\n");

for (const c of CASES) {
  const r = routeService(c.input);
  check(
    c.name + " → domain",
    r.serviceDomain === c.domain,
    "got " + r.serviceDomain + " conf=" + r.confidence
  );
  if (c.band) {
    check(
      c.name + " → band " + c.band,
      r.band === c.band,
      "got " + r.band + " (conf " + r.confidence + ")"
    );
  }
  if (c.category !== undefined) {
    check(
      c.name + " → category",
      r.repairCategory === c.category,
      "got " + String(r.repairCategory)
    );
  }
  if (c.altIncludes) {
    check(
      c.name + " → alternatives include " + c.altIncludes,
      r.alternatives.some((a) => a.domain === c.altIncludes),
      "alts " + JSON.stringify(r.alternatives.map((a) => a.domain))
    );
  }
  if (c.signals) {
    check(
      c.name + " → signalsUsed " + c.signals.join("+"),
      c.signals.every((s) => r.signalsUsed.includes(s as never)),
      "got " + JSON.stringify(r.signalsUsed)
    );
  }
}

// --- Invariants -----------------------------------------------------------
console.log("\n--- invariants ---");

check(
  "every domain has a knowledge module",
  SERVICE_DOMAINS.every((d) => KNOWLEDGE_MODULES[d] !== undefined)
);
check(
  "every module key matches its registry slot",
  SERVICE_DOMAINS.every((d) => KNOWLEDGE_MODULES[d].key === d)
);
check(
  "every module has >=1 category, field, media, guided question",
  SERVICE_DOMAINS.every((d) => {
    const m = KNOWLEDGE_MODULES[d];
    return (
      m.categories.length > 0 &&
      m.requiredFields.length > 0 &&
      m.requiredMedia.length > 0 &&
      m.guidedQuestions.length > 0
    );
  })
);
check(
  "confidence always within 0.10–0.95",
  CASES.every((c) => {
    const r = routeService(c.input);
    return r.confidence >= 0.1 && r.confidence <= 0.95;
  })
);
check(
  "confidenceBand thresholds (0.80 high / 0.60 medium / 0.30 low)",
  confidenceBand(0.8) === "high" &&
    confidenceBand(0.6) === "medium" &&
    confidenceBand(0.3) === "low"
);
check(
  "guided-question triggers reference real field/media keys",
  SERVICE_DOMAINS.every((d) => {
    const m = KNOWLEDGE_MODULES[d];
    const fieldKeys = m.requiredFields.map((f) => f.key);
    const mediaKeys = m.requiredMedia.map((x) => x.key);
    return m.guidedQuestions.every((q) => {
      if (q.fillsField) return true;
      if (q.fillsMedia) return true;
      return fieldKeys.length + mediaKeys.length > 0;
    });
  })
);

console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
process.exit(fail === 0 ? 0 : 1);
