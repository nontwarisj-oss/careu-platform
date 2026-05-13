// Bridge JWT minter — signs an HS256 token compatible with Supabase
// PostgREST's expected session JWT shape so RLS policies that reference
// auth.uid() resolve our LINE-authenticated users.
//
// Design:
//   • Subject (`sub`) = public.profiles.id. We do NOT create matching rows
//     in auth.users — PostgREST validates the signature only, then exposes
//     `sub` via auth.uid(). The strict RLS policies in 20260522 use
//     public.current_user_role() / current_user_branch_code() which look
//     up the profile by `id = auth.uid()`.
//   • Role claim is hardcoded to 'authenticated' — that's the Postgres
//     role PostgREST switches into. The *application* role (owner /
//     hq_admin / etc.) lives on profiles, not in the JWT.
//   • No refresh token. The JWT TTL is 8 hours; AuthProvider re-fetches
//     /api/auth/me before expiry to mint a fresh one. The HMAC session
//     cookie (careu_session) is the long-lived authentication; the JWT
//     is a short-lived derivation of it.
//
// Server-only. Never import from a "use client" file.

import crypto from "node:crypto";

const DEFAULT_TTL_SECONDS = 60 * 60 * 8; // 8h — comfortably longer than a shift

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function readJwtSecret(): string | null {
  const secret = process.env.SUPABASE_JWT_SECRET ?? "";
  // Supabase's default JWT secret is 64 chars; anything shorter than 32 is
  // almost certainly a misconfig. Reject so we don't quietly issue weak JWTs.
  if (secret.length < 32) return null;
  return secret;
}

export function isSupabaseJwtConfigured(): boolean {
  return readJwtSecret() !== null;
}

export type MintInput = {
  /** profiles.id — becomes the JWT `sub` claim and auth.uid() in Postgres. */
  profileId: string;
  /** Optional email claim for logging — not used by RLS. */
  email?: string | null;
  /** Override TTL. Default 8h. */
  ttlSeconds?: number;
};

export type MintedJwt = {
  token: string;
  expiresAt: number;     // epoch seconds
  expiresIn: number;     // seconds from now
};

export function mintSupabaseJwt(input: MintInput): MintedJwt | null {
  const secret = readJwtSecret();
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);

  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      sub: input.profileId,
      aud: "authenticated",
      role: "authenticated",
      iss: "careu-ops-bridge",
      iat: now,
      exp: expiresAt,
      email: input.email ?? undefined,
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = base64url(
    crypto.createHmac("sha256", secret).update(signingInput).digest()
  );

  return {
    token: `${signingInput}.${signature}`,
    expiresAt,
    expiresIn: expiresAt - now,
  };
}
