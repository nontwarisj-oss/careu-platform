// Human-readable job id generator + validator.
//
// Format:  YYMMDD-XXXX (optional prefix configurable via system_settings,
// not yet wired). The alphabet excludes ambiguous characters (0/O, 1/I/L)
// so a phone-relayed id over a noisy line is still unambiguous.

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 30 chars

function randomBlock(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

function todayStamp(): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/** Build one candidate; combine with a uniqueness check in the caller. */
export function generateJobIdCandidate(prefix = ""): string {
  const core = `${todayStamp()}-${randomBlock(4)}`;
  return prefix ? `${prefix}-${core}` : core;
}

/** Permissive validator — staff can type any non-empty token. */
export function isValidJobId(value: string): boolean {
  return /^[A-Za-z0-9_\-./]{1,32}$/.test(value);
}

/** Trim + uppercase for consistency. Returns null when empty/invalid. */
export function normalizeJobId(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!isValidJobId(trimmed)) return null;
  return trimmed.toUpperCase();
}

/**
 * Normalize a Job ID AS THE STAFF TYPE — bind this to the input's
 * `value` so the field self-corrects on every keystroke. Unlike
 * normalizeJobId (which validates and returns null on bad input),
 * this always returns a clean, valid string: leading/trailing and
 * internal spaces vanish, letters uppercase, and any character
 * outside the allowed set (A-Z 0-9 - _ . /) is dropped. Capped at 32.
 *
 *   "36 xx"  → "36XX"
 *   "  35xx" → "35XX"
 *
 * The result, when non-empty, always passes isValidJobId — so staff
 * never need to know that spaces are not allowed.
 */
export function sanitizeJobIdInput(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9\-._\/]/g, "")
    .slice(0, 32);
}
