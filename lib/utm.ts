// UTM Helper — builds + parses signed campaign tracking URLs.
//
// Compared to lib/trackingLinks.ts (which signs CLICK redirects):
// UTM links are CUSTOMER-facing landing URLs (e.g. /quote, /portal/
// orders, /branches/<slug>). Phase 20 ships:
//   • buildCampaignUrl(...) — append utm_* + (optional) signed `nid`
//     so the landing page can attribute conversions.
//   • parseUtmParams(url)   — strict pull of utm params from a URL.
//   • signedNidFromUrl(url) — verify the optional notification token.
//
// Signing semantics:
//   • The `nid` parameter on a UTM link is signed exactly like the
//     Phase 19 click-tracking token: HMAC-SHA256 with
//     TRACKING_LINK_SECRET. Prevents an attacker from claiming a
//     forged conversion against a campaign they weren't sent.
//   • UTM params themselves (source/medium/campaign) are NOT signed
//     — they're metadata for marketing analytics, not security
//     boundaries. Anyone can manually visit `/quote?utm_source=foo`
//     and that's fine (no attribution unless `nid` validates).
//
// Server-only.

import { signTrackingToken, verifyTrackingToken } from "@/lib/trackingLinks";

export const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_branch",
  "utm_channel",
] as const;

export type UtmParams = Partial<Record<(typeof UTM_KEYS)[number], string>>;

export type BuildCampaignUrlInput = {
  /** Absolute base URL (e.g. https://app.careu.tech) or a relative
   *  path (e.g. /quote). The output uses whatever shape you provide. */
  baseUrl: string;
  /** Optional UTM metadata. */
  utm?: UtmParams;
  /** Optional notification id — when provided, gets HMAC-signed and
   *  appended as `nid=<token>`. Required to make the landing page's
   *  attribution layer link back to a specific send. */
  notificationId?: string | null;
  /** TTL for the signed nid token. Defaults to 60 days. */
  ttlMs?: number;
};

/**
 * Build a campaign URL with optional UTM + signed `nid` query params.
 *
 * Example:
 *
 *   buildCampaignUrl({
 *     baseUrl: 'https://app.careu.tech/quote',
 *     utm: { utm_source: 'we_miss_you', utm_medium: 'line',
 *            utm_campaign: 'q2_retention',
 *            utm_branch: 'c24-thonburi-market',
 *            utm_channel: 'line' },
 *     notificationId: '8f4c2d…',
 *   })
 *   → https://app.careu.tech/quote?utm_source=we_miss_you&utm_medium=line&...
 *     &nid=v1.<base64>.<base64>
 */
export function buildCampaignUrl(input: BuildCampaignUrlInput): string | null {
  const { baseUrl, utm, notificationId, ttlMs } = input;
  const params = new URLSearchParams();
  for (const k of UTM_KEYS) {
    const v = utm?.[k];
    if (typeof v === "string" && v.trim().length > 0) {
      params.set(k, v.trim());
    }
  }
  if (notificationId) {
    const token = signTrackingToken({
      notificationId,
      url: baseUrl,
      kind: "click",
      ttlMs,
    });
    if (token) params.set("nid", token);
  }
  const sep = baseUrl.includes("?") ? "&" : "?";
  const qs = params.toString();
  if (qs.length === 0) return baseUrl;
  return `${baseUrl}${sep}${qs}`;
}

/**
 * Parse UTM parameters from a URL or a query-string. Strict — any
 * key outside UTM_KEYS is ignored.
 */
export function parseUtmParams(urlOrQuery: string): UtmParams {
  let qs: URLSearchParams;
  try {
    if (urlOrQuery.includes("?")) {
      qs = new URL(urlOrQuery, "http://placeholder").searchParams;
    } else {
      qs = new URLSearchParams(urlOrQuery.replace(/^\?/, ""));
    }
  } catch {
    return {};
  }
  const out: UtmParams = {};
  for (const k of UTM_KEYS) {
    const v = qs.get(k);
    if (typeof v === "string" && v.trim().length > 0) {
      out[k] = v.trim().slice(0, 120);
    }
  }
  return out;
}

/**
 * Extract + verify the signed `nid` token from a URL / query string.
 * Returns the verified notification_id or null when:
 *   • the token is missing
 *   • the signature is invalid
 *   • the token has expired
 *
 * Use this from the landing page server-side handler to know which
 * notification (if any) drove the customer to this URL.
 */
export function verifiedNotificationIdFromUrl(
  urlOrQuery: string
): string | null {
  let qs: URLSearchParams;
  try {
    if (urlOrQuery.includes("?")) {
      qs = new URL(urlOrQuery, "http://placeholder").searchParams;
    } else {
      qs = new URLSearchParams(urlOrQuery.replace(/^\?/, ""));
    }
  } catch {
    return null;
  }
  const token = qs.get("nid");
  if (!token) return null;
  const v = verifyTrackingToken(token);
  if (!v.ok) return null;
  return v.payload.nid;
}

/**
 * Convenience: pick UTM + nid attribution off a Request object's URL.
 * Used inside API route handlers / page server components.
 */
export function attributionFromUrl(url: string): {
  utm: UtmParams;
  notificationId: string | null;
} {
  return {
    utm: parseUtmParams(url),
    notificationId: verifiedNotificationIdFromUrl(url),
  };
}
