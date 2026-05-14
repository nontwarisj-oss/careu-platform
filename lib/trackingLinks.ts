// Signed Tracking Links — HMAC-signed redirect tokens for click +
// open pixel tracking.
//
// Why HMAC tokens (not opaque IDs):
//   • No DB lookup on every redirect — the verifier accepts/rejects
//     in O(1).
//   • Forging a click for a notification the customer never received
//     requires knowing TRACKING_LINK_SECRET. Without it, /api/track
//     refuses.
//   • Expiry stamped INTO the token, so a forgotten link can't be
//     replayed forever.
//
// Token format (URL-safe base64):
//   <header>.<payload>.<signature>
//   header   = "v1"
//   payload  = base64url(JSON({ nid, url, exp, kind }))
//   signature= base64url(HMAC-SHA256(TRACKING_LINK_SECRET, header + "." + payload))
//
// Server-only — the redirect routes verify before recording the event.

import crypto from "node:crypto";

const HEADER = "v1";
const DEFAULT_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export type TrackingPayload = {
  /** customer_notifications.id — used to attribute the click. */
  nid: string;
  /** Target URL the customer is redirected to (for click links). For
   *  open pixels, this is a sentinel "open". */
  url: string;
  /** Expiry epoch ms. */
  exp: number;
  /** 'click' | 'open' */
  kind: "click" | "open";
};

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function getSecret(): string | null {
  const s = process.env.TRACKING_LINK_SECRET ?? process.env.SESSION_SECRET ?? "";
  return s.length >= 16 ? s : null;
}

export function signTrackingToken(opts: {
  notificationId: string;
  url: string;
  kind: "click" | "open";
  ttlMs?: number;
}): string | null {
  const secret = getSecret();
  if (!secret) return null;
  const payload: TrackingPayload = {
    nid: opts.notificationId,
    url: opts.url,
    exp: Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS),
    kind: opts.kind,
  };
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const signed = `${HEADER}.${payloadB64}`;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(signed, "utf8")
    .digest();
  return `${signed}.${b64urlEncode(sig)}`;
}

export function verifyTrackingToken(
  token: string
): { ok: true; payload: TrackingPayload } | { ok: false; reason: string } {
  const secret = getSecret();
  if (!secret) return { ok: false, reason: "TRACKING_LINK_SECRET not set" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "bad shape" };
  const [header, payloadB64, sig] = parts;
  if (header !== HEADER) return { ok: false, reason: "bad header" };

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${payloadB64}`, "utf8")
    .digest();
  const givenSig = b64urlDecode(sig);
  if (givenSig.length !== expectedSig.length) {
    return { ok: false, reason: "bad signature" };
  }
  if (!crypto.timingSafeEqual(givenSig, expectedSig)) {
    return { ok: false, reason: "bad signature" };
  }

  let payload: TrackingPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as TrackingPayload;
  } catch {
    return { ok: false, reason: "bad payload" };
  }
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (!payload.nid || typeof payload.nid !== "string") {
    return { ok: false, reason: "no nid" };
  }
  return { ok: true, payload };
}

/**
 * Build a public tracking URL for use in email/SMS bodies.
 *
 * Examples (with NEXT_PUBLIC_BASE_URL=https://app.careu.tech):
 *
 *   buildClickUrl({ notificationId, targetUrl: "https://care.u/promo" })
 *   → https://app.careu.tech/api/track/click?t=<token>
 *
 *   buildOpenPixel(notificationId)
 *   → https://app.careu.tech/api/track/open?t=<token>
 */
export function buildClickUrl(opts: {
  baseUrl: string;
  notificationId: string;
  targetUrl: string;
}): string | null {
  const token = signTrackingToken({
    notificationId: opts.notificationId,
    url: opts.targetUrl,
    kind: "click",
  });
  if (!token) return null;
  return `${stripTrailingSlash(opts.baseUrl)}/api/track/click?t=${encodeURIComponent(token)}`;
}

export function buildOpenPixelUrl(opts: {
  baseUrl: string;
  notificationId: string;
}): string | null {
  const token = signTrackingToken({
    notificationId: opts.notificationId,
    url: "open",
    kind: "open",
  });
  if (!token) return null;
  return `${stripTrailingSlash(opts.baseUrl)}/api/track/open?t=${encodeURIComponent(token)}`;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
