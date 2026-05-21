// Draft ID generator for the mobile intake workflow.
//
// Format: DYYMMDD-NNN  (e.g. D260518-001) — short, human-readable, easy to
// write on a paper bag tag. The NNN sequence resets every day.
//
// Pure helpers only. The actual daily sequence is resolved server-side by
// the draft route (it must read the DB) — these helpers stay testable and
// dependency-free, mirroring lib/jobId.ts.

/** YYMMDD stamp for the given date (defaults to now). */
export function draftDateStamp(date: Date = new Date()): string {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/** Build a Draft ID from a YYMMDD stamp + a 1-based daily sequence.
 *  `prefix` defaults to 'D' for mobile-intake drafts. The website bridge
 *  passes 'W' so a draft's source is visible at a glance in logs and the
 *  admin queue (e.g. "W260520-001" = website-sourced 1st of the day). */
export function buildDraftCode(
  stamp: string,
  seq: number,
  prefix: string = "D"
): string {
  const n = Math.max(1, Math.floor(seq));
  return `${prefix}${stamp}-${String(n).padStart(3, "0")}`;
}

/** Pull the numeric sequence out of a Draft ID. Returns null when unparsable. */
export function parseDraftSeq(code: string): number | null {
  const m = /-(\d+)$/.exec(code.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
