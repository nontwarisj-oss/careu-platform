// Canonicalize a phone number into the Thai local 10-digit format starting
// with "0", regardless of whether the source had spaces, dashes, country
// prefix or a leading zero already.
//
// Examples:
//   "081-234-5678"     -> "0812345678"
//   "+66 81-234-5678"  -> "0812345678"   (66XXXXXXXXX → 0XXXXXXXXX)
//   "66812345678"      -> "0812345678"
//   "812345678"        -> "0812345678"   (9-digit, leading zero dropped)
//   "0066812345678"    -> "0812345678"   (00 international prefix)
//   "0812345678"       -> "0812345678"   (already canonical)
//
// Non-Thai or otherwise unrecognized lengths fall through as the bare digit
// string so we never lose information.
export function normalizePhone(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");
  if (!digits) return "";

  // "0066XXXXXXXXX" — international access code prefix
  if (digits.length === 13 && digits.startsWith("0066")) {
    return "0" + digits.slice(4);
  }

  // "066XXXXXXXXX" — sometimes seen when a stray leading zero meets +66
  if (digits.length === 12 && digits.startsWith("066")) {
    return "0" + digits.slice(3);
  }

  // "66XXXXXXXXX" — bare country code (the most common case for +66)
  if (digits.length === 11 && digits.startsWith("66")) {
    return "0" + digits.slice(2);
  }

  // 9-digit local number with the leading zero dropped (often happens after
  // Excel coerces phone columns into numbers).
  if (digits.length === 9) {
    return "0" + digits;
  }

  return digits;
}

/** True when two phone strings refer to the same line. */
export function samePhone(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  return na.length > 0 && na === nb;
}
