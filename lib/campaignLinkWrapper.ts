// Campaign Link Wrapper — rewrites bare URLs in a broadcast body so
// every customer click is signed, tracked, and UTM-tagged.
//
// Before Phase 22 operators had to paste pre-wrapped URLs into the
// draft by hand (the "known limitation" from Phase 20). This helper
// does it automatically at fan-out time:
//
//   1. Scan the SMS / LINE / email body for http(s) URLs.
//   2. For each bare URL, attach UTM params (utm.ts) so the landing
//      page can attribute the visit.
//   3. Wrap the UTM-tagged URL inside a signed click-tracking
//      redirect (trackingLinks.ts) so /api/track/click records the
//      click before forwarding.
//   4. Leave already-wrapped URLs (those that already point at
//      /api/track/click) untouched — no double-wrapping.
//
// The original URL is preserved INSIDE the signed token's payload —
// /api/track/click verifies the token then 302s to it. Nothing is
// lost; the customer still lands where the operator intended.
//
// Best-effort: when TRACKING_LINK_SECRET is unset (buildClickUrl
// returns null) or the base URL is missing, the body is returned
// unchanged. A campaign must still send even if tracking is off.
//
// Server-only.

import { buildClickUrl } from "@/lib/trackingLinks";
import { buildCampaignUrl, type UtmParams } from "@/lib/utm";

// Matches http:// and https:// URLs. Deliberately conservative —
// stops at whitespace and the handful of characters that are almost
// never part of a URL in a marketing message. Good enough for SMS /
// LINE bodies (we are not parsing arbitrary HTML).
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** Trailing punctuation that is almost always sentence punctuation,
 *  not part of the URL. Stripped off the match + re-appended after. */
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

export type WrapResult = {
  /** The body with bare URLs replaced by tracked URLs. */
  body: string;
  /** How many URLs were wrapped this pass. */
  wrappedCount: number;
  /** How many URLs were already tracked and left alone. */
  skippedCount: number;
};

function isAlreadyTracked(url: string): boolean {
  return (
    url.includes("/api/track/click") || url.includes("/api/track/open")
  );
}

/**
 * Wrap every bare URL in `body` with a signed, UTM-tagged tracking
 * link. Idempotent — running it twice produces the same output
 * because already-tracked URLs are skipped.
 */
export function wrapCampaignLinks(opts: {
  body: string;
  /** customer_notifications.id the click should attribute to. */
  notificationId: string;
  /** Public base URL, e.g. https://app.careu.tech. */
  baseUrl: string;
  /** UTM metadata attached to the inner landing URL. */
  utm?: UtmParams;
}): WrapResult {
  const { body, notificationId, baseUrl, utm } = opts;
  if (!body || !baseUrl) {
    return { body, wrappedCount: 0, skippedCount: 0 };
  }

  let wrappedCount = 0;
  let skippedCount = 0;

  const next = body.replace(URL_RE, (match) => {
    // Peel trailing sentence punctuation off the match.
    const punct = TRAILING_PUNCT.exec(match)?.[0] ?? "";
    const rawUrl = punct ? match.slice(0, -punct.length) : match;

    if (isAlreadyTracked(rawUrl)) {
      skippedCount += 1;
      return match;
    }

    // Step 1: attach UTM to the landing URL.
    const landing =
      utm && Object.keys(utm).length > 0
        ? buildCampaignUrl({ baseUrl: rawUrl, utm }) ?? rawUrl
        : rawUrl;

    // Step 2: wrap the UTM-tagged URL in a signed click redirect.
    const tracked = buildClickUrl({
      baseUrl,
      notificationId,
      targetUrl: landing,
    });
    if (!tracked) {
      // Tracking secret unset — leave the URL (with UTM) as-is.
      return `${landing}${punct}`;
    }
    wrappedCount += 1;
    return `${tracked}${punct}`;
  });

  return { body: next, wrappedCount, skippedCount };
}

/**
 * Does the body contain at least one bare (untracked) URL? Used by
 * the smoke-test + the broadcast editor preview to tell the operator
 * "this draft has N links that will be auto-tracked on send".
 */
export function countBareUrls(body: string | null | undefined): number {
  if (!body) return 0;
  const matches = body.match(URL_RE) ?? [];
  return matches.filter((m) => {
    const punct = TRAILING_PUNCT.exec(m)?.[0] ?? "";
    const raw = punct ? m.slice(0, -punct.length) : m;
    return !isAlreadyTracked(raw);
  }).length;
}
