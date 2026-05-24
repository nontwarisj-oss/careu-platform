// Phase C / L6 — Guided Question Engine ("AI สั่งคนรับงาน").
//
// The heart of AI Intake (design doc AI-INTAKE-DESIGN-23MAY2026.md §4):
// staff price jobs from incomplete information and mis-quote. This engine
// turns a Knowledge Module + the draft's current state into a concrete
// missing-info checklist and a set of polite draft questions.
//
// Pure — no DB, no fetch, no model call, no React. Given:
//   - the service domain the Router picked, and
//   - DraftSignals: what the draft already carries,
// it returns, per design §4:
//   - `have`     — a human-readable "already provided" summary,
//   - `missing`  — every required field/media + every guided-question
//                  slot still unfilled (the checklist itself),
//   - `customerQuestions` — distinct polite questions to send the
//                  customer (drafts only — a human presses send, F3),
//   - `requiredComplete`  — true once every REQUIRED slot is filled
//                  (the "enough info to price" gate).
//
// F3 guard: this engine only DRAFTS. It never sends a LINE message,
// never sets a price, never converts a draft. /admin/intake-drafts (L7)
// owns the send + confirm buttons.

import {
  getModule,
  type ServiceDomain,
  type ModuleField,
  type ModuleMedia,
  type GuidedQuestion,
} from "./knowledgeModules";

// ---------- Input ----------------------------------------------------------

export type DraftSignals = {
  /** Draft carries customer free text / staff_note. */
  hasText: boolean;
  /** Number of photos attached (intake_draft_media rows). */
  photoCount: number;
  /** Field slot keys an admin/AI has already marked satisfied. */
  filledFields?: string[];
  /** Media slot keys already satisfied (e.g. a tagged "hem_closeup"). */
  filledMedia?: string[];
};

// ---------- Output ---------------------------------------------------------

export type ChecklistItemKind = "field" | "media";

export type ChecklistItem = {
  kind: ChecklistItemKind;
  /** Field or media slot key from the Knowledge Module. */
  key: string;
  /** Short Thai label for the admin checklist line. */
  labelTh: string;
  /** True when this slot is in the module's required_* set — i.e. the
   *  job cannot be priced accurately until it is filled. */
  required: boolean;
  /** Polite draft question for the customer — "" when the module has
   *  no guided question for this slot (admin reads it from the photo). */
  questionTh: string;
};

export type GuidedChecklist = {
  serviceDomain: ServiceDomain;
  displayNameTh: string;
  /** Human-readable lines describing what the draft already provides. */
  have: string[];
  /** The missing-info checklist — required gaps first, then optional. */
  missing: ChecklistItem[];
  /** Distinct customer-facing questions for the missing items. */
  customerQuestions: string[];
  /** True when every required field + media slot is filled. */
  requiredComplete: boolean;
};

// ---------- Engine ---------------------------------------------------------

function slotId(kind: ChecklistItemKind, key: string): string {
  return kind + ":" + key;
}

/** The guided question that targets a given field/media slot, if any. */
function questionForSlot(
  questions: GuidedQuestion[],
  kind: ChecklistItemKind,
  key: string
): string {
  for (const q of questions) {
    if (kind === "field" && q.fillsField === key) return q.questionTh;
    if (kind === "media" && q.fillsMedia === key) return q.questionTh;
  }
  return "";
}

/**
 * Build the missing-info checklist for a draft.
 *
 * A brand-new LINE/website draft has no tagged slots, so every required
 * field/media and every guided-question slot comes back missing — which
 * is exactly the design §4 example. As the admin tags slots or the
 * customer answers, filled slots drop out and their questions are never
 * re-asked.
 */
export function buildChecklist(
  domain: ServiceDomain,
  signals: DraftSignals
): GuidedChecklist {
  const mod = getModule(domain);
  const filledFields = new Set(signals.filledFields ?? []);
  const filledMedia = new Set(signals.filledMedia ?? []);

  const requiredFieldKeys = new Set(mod.requiredFields.map((f) => f.key));
  const requiredMediaKeys = new Set(mod.requiredMedia.map((m) => m.key));

  // Keyed by slotId so a required field that ALSO has a guided question
  // is listed once.
  const items = new Map<string, ChecklistItem>();

  // 1) Required fields still missing.
  for (const f of mod.requiredFields) {
    if (filledFields.has(f.key)) continue;
    items.set(slotId("field", f.key), {
      kind: "field",
      key: f.key,
      labelTh: f.labelTh,
      required: true,
      questionTh: questionForSlot(mod.guidedQuestions, "field", f.key),
    });
  }
  // 2) Required media still missing.
  for (const m of mod.requiredMedia) {
    if (filledMedia.has(m.key)) continue;
    items.set(slotId("media", m.key), {
      kind: "media",
      key: m.key,
      labelTh: m.labelTh,
      required: true,
      questionTh: questionForSlot(mod.guidedQuestions, "media", m.key),
    });
  }
  // 3) Guided-question slots still missing (incl. optional ones the
  //    module asks about but does not strictly require for pricing).
  for (const q of mod.guidedQuestions) {
    const kind: ChecklistItemKind = q.fillsMedia ? "media" : "field";
    const key = q.fillsField ?? q.fillsMedia ?? q.trigger;
    const filled = kind === "media" ? filledMedia : filledFields;
    if (filled.has(key)) continue;
    const id = slotId(kind, key);
    if (items.has(id)) continue; // already covered as a required slot
    const required =
      kind === "field"
        ? requiredFieldKeys.has(key)
        : requiredMediaKeys.has(key);
    items.set(id, {
      kind,
      key,
      labelTh: q.questionTh,
      required,
      questionTh: q.questionTh,
    });
  }

  // Required gaps first, then optional — stable + admin-friendly order.
  const missing = [...items.values()].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return 0;
  });

  // "Already have" summary.
  const have: string[] = [];
  if (signals.hasText) have.push("คำอธิบายจากลูกค้า");
  if (signals.photoCount > 0) have.push("รูป " + signals.photoCount + " รูป");
  for (const key of filledFields) {
    const f = mod.requiredFields.find((x) => x.key === key);
    if (f) have.push(f.labelTh);
  }
  for (const key of filledMedia) {
    const m = mod.requiredMedia.find((x) => x.key === key);
    if (m) have.push(m.labelTh);
  }

  // Distinct customer questions, required first (missing is already sorted).
  const customerQuestions: string[] = [];
  for (const it of missing) {
    if (it.questionTh && !customerQuestions.includes(it.questionTh)) {
      customerQuestions.push(it.questionTh);
    }
  }

  const requiredComplete = !missing.some((it) => it.required);

  return {
    serviceDomain: domain,
    displayNameTh: mod.displayNameTh,
    have,
    missing,
    customerQuestions,
    requiredComplete,
  };
}

// ---------- Admin-facing render (design §4 box) ---------------------------

/**
 * Render the checklist as the plain-text "AI สั่งงาน Intake" block the
 * admin sees in /admin/intake-drafts. Pure string builder — the actual
 * [ ส่งคำถามให้ลูกค้า ] / [ แอดมินถามเอง ] buttons are wired in L7.
 */
export function renderAdminChecklist(
  checklist: GuidedChecklist,
  opts?: { draftCode?: string; confidence?: number }
): string {
  const lines: string[] = [];
  lines.push("🧵 AI สั่งงาน Intake" + (opts?.draftCode ? " — " + opts.draftCode : ""));
  const conf =
    typeof opts?.confidence === "number"
      ? " · มั่นใจ " + opts.confidence.toFixed(2)
      : "";
  lines.push(
    "ประเภท: " +
      checklist.displayNameTh +
      " (" +
      checklist.serviceDomain +
      ")" +
      conf
  );
  lines.push("─────────────────────────");
  lines.push(
    checklist.have.length > 0
      ? "✅ มีแล้ว: " + checklist.have.join(" · ")
      : "✅ มีแล้ว: —"
  );
  if (checklist.missing.length === 0) {
    lines.push("✔️ ข้อมูลครบสำหรับประเมินราคาแล้ว");
  } else {
    for (const it of checklist.missing) {
      const tag = it.required ? "⬜ ยังขาด" : "▫️ ขอเพิ่ม";
      lines.push(tag + ": " + it.labelTh);
    }
  }
  lines.push("─────────────────────────");
  lines.push("[ ส่งคำถามให้ลูกค้า ]   [ แอดมินถามเอง ]");
  return lines.join("\n");
}

export type { ModuleField, ModuleMedia };
