// In-memory token-bucket rate limiter for public routes.
//
// Scope: enough to protect /api/public/* endpoints (track + quote) from
// casual abuse. NOT cluster-aware — each serverless cold-start gets a
// fresh map. For higher-fidelity limiting (cross-instance, persistent),
// swap the backing store for Redis / Upstash later; the helper signature
// stays the same.
//
// Why not a distributed limiter today: the public endpoints are read-only
// (track) or write-once-on-submission (quote). A burst from one IP that
// survives a cold-start gives an attacker at most a few extra requests
// before the next instance picks them up. Acceptable trade-off for a
// foundation phase; documented as a known limitation.
//
// Server-only. Never import from a "use client" file.

type Bucket = {
  /** Timestamps (ms) of recent allowed requests, sliding window. */
  hits: number[];
};

const STORE = new Map<string, Bucket>();
/** Hard cap on tracked keys per process — prevents an attacker from
 *  growing the map unbounded with one request per IP. */
const STORE_CAP = 5000;

export type RateLimitResult = {
  ok: boolean;
  /** How many requests remain in the current window. */
  remaining: number;
  /** ISO 8601 timestamp when the next slot frees up. */
  resetAt: string;
  /** Reason when ok=false, for the API response. */
  reason?: string;
};

export type RateLimitOptions = {
  /** Distinct namespace per endpoint so /track and /quote don't share buckets. */
  namespace: string;
  /** Max requests allowed in `windowMs`. */
  limit: number;
  /** Sliding window length in milliseconds. */
  windowMs: number;
};

/**
 * Check + consume one slot. Returns ok=true and decrements the bucket on
 * a fresh hit, or ok=false (with a reason) when the window is full.
 *
 * The key is up to the caller — typically request IP plus an additional
 * dimension (phone for /track, branch for /quote) so different users
 * sharing a NAT'd IP don't penalise each other.
 */
export function rateLimit(
  key: string,
  options: RateLimitOptions
): RateLimitResult {
  const composite = `${options.namespace}::${key}`;
  const now = Date.now();
  const cutoff = now - options.windowMs;

  // Periodically evict to keep the map bounded. Cheap O(n) sweep on a
  // single insertion when the cap is hit — fine for the volumes a public
  // marketing site sees.
  if (STORE.size >= STORE_CAP) {
    for (const [k, b] of STORE.entries()) {
      if (b.hits.every((t) => t < cutoff)) STORE.delete(k);
    }
  }

  const bucket = STORE.get(composite) ?? { hits: [] };
  // Drop hits outside the current window.
  bucket.hits = bucket.hits.filter((t) => t >= cutoff);

  if (bucket.hits.length >= options.limit) {
    const oldestHit = bucket.hits[0] ?? now;
    const resetAt = new Date(oldestHit + options.windowMs).toISOString();
    return {
      ok: false,
      remaining: 0,
      resetAt,
      reason: `Rate limit: ${options.limit} requests per ${Math.round(
        options.windowMs / 1000
      )}s exceeded`,
    };
  }

  bucket.hits.push(now);
  STORE.set(composite, bucket);

  return {
    ok: true,
    remaining: options.limit - bucket.hits.length,
    resetAt: new Date(now + options.windowMs).toISOString(),
  };
}

/**
 * Best-effort caller IP. Pulls from common forwarded headers (Vercel sets
 * `x-forwarded-for`); falls back to "unknown" so a missing header doesn't
 * make every request share one bucket.
 */
export function callerIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // x-forwarded-for can be a comma-separated list; first entry is the
    // originating client.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xreal = req.headers.get("x-real-ip");
  if (xreal) return xreal;
  return "unknown";
}
