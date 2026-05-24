// Phase C / L5 — AI Service Router.
//
// A CLASSIFIER ONLY (design doc §5.1). Given the multi-signal input a
// draft carries — customer text, the bot's vision image labels, and a
// voice transcript — it picks one of the 7 service domains, a best-effort
// repair category, a 0..1 confidence, and low-confidence alternatives.
//
// Engine: deterministic hint-scoring against each module's
// classificationHints (lib/knowledgeModules.ts). Pure — no DB, no fetch,
// no model call — so it is fast, free, and unit-testable.
//
// F7 (phased / reversible): RouterInput and RouterResult are the stable
// contract. A Claude-backed engine can replace `routeService`'s body
// later WITHOUT changing callers — the classify route and the (future)
// Guided Question Engine only read RouterResult.
//
// F3 guard: output lands in AI-SUGGESTED fields only. confirmed_* stays
// human-only in /admin/intake-drafts. The Router never sets a price.

import {
  KNOWLEDGE_MODULES,
  SERVICE_DOMAINS,
  FALLBACK_DOMAIN,
  type ServiceDomain,
} from "./knowledgeModules";

// ---------- Contract -------------------------------------------------------

export type RouterSignal = "text" | "image" | "voice";

export type RouterInput = {
  /** Customer free text — staff_note / message body. */
  text: string | null;
  /** Vision labels from the bot's image classifier (visionClassify). */
  imageLabels?: string[] | null;
  /** Voice transcript (STT) — empty until that phase ships. */
  voiceTranscript?: string | null;
};

export type ConfidenceBand = "high" | "medium" | "low";

export type RouterAlternative = {
  domain: ServiceDomain;
  confidence: number;
};

export type RouterResult = {
  serviceDomain: ServiceDomain;
  /** Best-effort module category key — null when text gives no hint. */
  repairCategory: string | null;
  /** 0.00 – 0.95, rounded to 2dp. */
  confidence: number;
  band: ConfidenceBand;
  signalsUsed: RouterSignal[];
  alternatives: RouterAlternative[];
  /** Hint tokens that fired for the winning domain — for logs / tuning. */
  matchedKeywords: string[];
};

// ---------- Confidence policy (design doc §5.5 — thresholds tunable) ------

const HIGH_MIN = 0.75;
const MEDIUM_MIN = 0.45;

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= HIGH_MIN) return "high";
  if (confidence >= MEDIUM_MIN) return "medium";
  return "low";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Map a winning raw score + its share of the total evidence to a
 * 0..0.95 confidence. A domain that owns most of the evidence AND has
 * several hits scores high; a domain tied with others, or with a single
 * weak hit, lands in the medium band so the Core Brain asks one
 * clarifying question before committing.
 */
function scoreToConfidence(winnerScore: number, totalScore: number): number {
  if (winnerScore <= 0 || totalScore <= 0) return 0.1;
  const share = winnerScore / totalScore;
  const volume = Math.min(1, winnerScore / 4);
  return round2(clamp(0.3 + 0.32 * share + 0.3 * volume, 0.1, 0.95));
}

// ---------- Signal matching ----------------------------------------------

function normalize(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().trim();
}

/** Count DISTINCT hint tokens that appear as substrings of `haystack`. */
function matchTokens(haystack: string, tokens: string[]): string[] {
  if (!haystack) return [];
  const hits: string[] = [];
  for (const token of tokens) {
    const t = token.toLowerCase().trim();
    if (t && haystack.includes(t) && !hits.includes(t)) hits.push(t);
  }
  return hits;
}

type DomainScore = {
  domain: ServiceDomain;
  score: number;
  keywords: string[];
  signals: Set<RouterSignal>;
};

/** Score every domain against the input. */
function scoreDomains(input: RouterInput): DomainScore[] {
  const text = normalize(input.text);
  const voice = normalize(input.voiceTranscript);
  const labels = (input.imageLabels ?? [])
    .map((l) => normalize(l))
    .filter((l) => l.length > 0);
  const labelBlob = labels.join(" ");

  return SERVICE_DOMAINS.map((domain) => {
    const mod = KNOWLEDGE_MODULES[domain];
    const hints = mod.classificationHints;
    const signals = new Set<RouterSignal>();
    const keywords: string[] = [];

    const textHits = matchTokens(text, hints.keywordsTh);
    if (textHits.length > 0) {
      signals.add("text");
      keywords.push(...textHits);
    }
    const voiceHits = matchTokens(voice, hints.keywordsTh);
    if (voiceHits.length > 0) {
      signals.add("voice");
      for (const k of voiceHits) if (!keywords.includes(k)) keywords.push(k);
    }
    const imageHits = matchTokens(labelBlob, hints.imageLabels);
    if (imageHits.length > 0) {
      signals.add("image");
      keywords.push(...imageHits);
    }

    return {
      domain,
      score: textHits.length + voiceHits.length + imageHits.length,
      keywords,
      signals,
    };
  });
}

// ---------- Repair category (best-effort) ---------------------------------

// Generic verbs that appear across many category labels — excluded from
// chunk matching so they do not cross-match unrelated categories.
const CATEGORY_STOPWORDS = ["ซ่อม", "เปลี่ยน", "ติด", "ปรับ", "ทำ", "ทำสี", "แก้"];

/** Pick the winning module's category whose label overlaps the text
 *  most. Labels are split on space and "/" into chunks; a chunk counts
 *  when it appears as a substring of the customer text. */
function inferRepairCategory(
  domain: ServiceDomain,
  text: string
): string | null {
  if (!text) return null;
  const mod = KNOWLEDGE_MODULES[domain];
  let best: string | null = null;
  let bestHits = 0;
  for (const cat of mod.categories) {
    const chunks = cat.labelTh
      .toLowerCase()
      .split(/[\s/]+/)
      .map((c) => c.trim())
      // Drop bare generic verbs and 1-3 char fragments so a label like
      // "ซ่อม/ติดพื้นรองเท้า" matches on "ติดพื้นรองเท้า", not "ซ่อม".
      .filter((c) => c.length >= 4 && !CATEGORY_STOPWORDS.includes(c));
    let hits = 0;
    for (const chunk of chunks) if (text.includes(chunk)) hits += 1;
    if (hits > bestHits) {
      bestHits = hits;
      best = cat.key;
    }
  }
  return bestHits > 0 ? best : null;
}

// ---------- Public entry point --------------------------------------------

/**
 * Classify a draft's signals into a service domain.
 *
 * When no hint fires at all, returns the catch-all domain (ezy_other)
 * at confidence 0.10 / band "low" — the Core Brain reads that as
 * "do not guess; route to staff" (design doc §5.5).
 */
export function routeService(input: RouterInput): RouterResult {
  const scores = scoreDomains(input);
  const total = scores.reduce((sum, s) => sum + s.score, 0);

  // Winner: highest score; ties break by SERVICE_DOMAINS order (stable).
  let winner = scores[0];
  for (const s of scores) if (s.score > winner.score) winner = s;

  if (winner.score === 0) {
    return {
      serviceDomain: FALLBACK_DOMAIN,
      repairCategory: null,
      confidence: 0.1,
      band: "low",
      signalsUsed: [],
      alternatives: [],
      matchedKeywords: [],
    };
  }

  const confidence = scoreToConfidence(winner.score, total);
  const text = normalize(input.text) + " " + normalize(input.voiceTranscript);

  const alternatives: RouterAlternative[] = scores
    .filter((s) => s.domain !== winner.domain && s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => ({
      domain: s.domain,
      confidence: scoreToConfidence(s.score, total),
    }));

  const signalOrder: RouterSignal[] = ["text", "image", "voice"];

  return {
    serviceDomain: winner.domain,
    repairCategory: inferRepairCategory(winner.domain, text.trim()),
    confidence,
    band: confidenceBand(confidence),
    signalsUsed: signalOrder.filter((sig) => winner.signals.has(sig)),
    alternatives,
    matchedKeywords: winner.keywords,
  };
}
