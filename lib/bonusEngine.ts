// Bonus engine — suggested bonus from performance ratio.
//
// The owner / hq_admin remains the decision-maker; this module produces a
// *suggestion* the payroll UI pre-fills into the bonus input. The owner
// can accept, raise, lower, or zero it out.
//
// Why a separate module: the formula is product policy, not platform
// plumbing. Putting it in one place means HQ can adjust the curve (or
// migrate to a config table later) without touching the route handler or
// the payroll UI.
//
// Persistence: when /api/admin/payroll/save-item runs, both the
// `bonus_amount` (what the owner kept) AND `bonus_suggested` (what the
// engine recommended) are written to technician_payroll_items so a future
// audit can detect overrides. The rule version is stamped too.
//
// Server-friendly (no React imports).

export type BonusRule = {
  /** Identifier persisted as bonus_rule_version. Bump when the formula changes. */
  version: string;
  /** Minimum performance ratio to earn any bonus. Default 1.00 (must hit target). */
  threshold: number;
  /** Fraction of the over-target portion that flows back as bonus.
   *  Default 0.20 (20 % of the overage). */
  rate: number;
  /** Cap on the bonus as a multiplier of baseWage. Default 1.0 (max 100 %
   *  of base wage as bonus). */
  capBaseMultiplier: number;
  /** Human-readable description for the admin UI. */
  description: { th: string; en: string };
};

export const BONUS_RULES: BonusRule = {
  version: "v1-perf-overage-20pct",
  threshold: 1.0,
  rate: 0.2,
  capBaseMultiplier: 1.0,
  description: {
    th: "Bonus = (อัตราส่วน − 1) × ค่าแรง × 20% — เริ่มที่ ratio ≥ 1.0 · จำกัดสูงสุด 100% ของค่าแรง",
    en: "Bonus = (ratio − 1) × base × 20% — kicks in at ratio ≥ 1.0 · capped at 100 % of base wage.",
  },
};

// ---------- Pure calculation ---------------------------------------------

export type BonusSuggestion = {
  /** Suggested bonus in baht. Rounded to whole baht (no satang). */
  amount: number;
  /** The rule version used. Stamped on the persisted row. */
  ruleVersion: string;
  /** Whether the suggestion is non-zero. False when below threshold. */
  qualifies: boolean;
  /** Inputs the formula used — useful for tooltips + future audit. */
  factors: {
    performanceRatio: number;
    baseWage: number;
    overageRatio: number;
    rate: number;
    cap: number;
  };
};

/**
 * Compute the suggested bonus given a technician's performance metrics.
 * Returns `amount: 0` when:
 *   • performanceRatio < threshold (didn't hit target)
 *   • baseWage <= 0 (no working days that month)
 *   • the rate or cap would round below 1 baht
 *
 * The amount is rounded to whole baht to avoid noise in payroll totals.
 */
export function calculateSuggestedBonus(input: {
  performanceRatio: number;
  baseWage: number;
}): BonusSuggestion {
  const rule = BONUS_RULES;
  const ratio = Number.isFinite(input.performanceRatio)
    ? Math.max(0, input.performanceRatio)
    : 0;
  const base = Math.max(0, Number(input.baseWage) || 0);
  const overage = Math.max(0, ratio - rule.threshold);
  const cap = base * rule.capBaseMultiplier;

  const raw = overage * base * rule.rate;
  const capped = Math.min(raw, cap);
  const amount = capped >= 1 ? Math.round(capped) : 0;

  return {
    amount,
    ruleVersion: rule.version,
    qualifies: amount > 0,
    factors: {
      performanceRatio: ratio,
      baseWage: base,
      overageRatio: overage,
      rate: rule.rate,
      cap,
    },
  };
}

/** True when the saved bonus diverges from the suggestion by more than 1 baht. */
export function isOverride(
  suggestion: BonusSuggestion,
  saved: number
): boolean {
  return Math.abs(saved - suggestion.amount) >= 1;
}
