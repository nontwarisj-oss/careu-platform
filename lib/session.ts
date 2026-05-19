// HMAC-signed session cookies. We deliberately do not run Supabase Auth or
// NextAuth here — the only identity provider for the platform is LINE Login,
// and a self-contained signed cookie keeps the runtime small + edge-friendly
// while still being verifiable on every request.
//
// Cookie layout:  base64url(JSON payload).base64url(HMAC-SHA256 signature)
//
// Payload:        { uid, role, branchId, name, sub, iat, exp }
//   - uid       = public.users.id (uuid)
//   - sub       = users.line_user_id (provider subject)
//   - exp       = epoch seconds; default 7 days
//
// Signing key:   SESSION_SECRET — or the STAFF_SESSION_SECRET /
//                INTERNAL_SESSION_SECRET aliases — read from the runtime
//                environment at call time. Must be ≥ 32 chars.
//
// Server-only — never import from a "use client" file.

import crypto from "node:crypto";
import { cookies } from "next/headers";
import { normalizeRole, type Role } from "@/lib/roles";

const COOKIE_NAME = "careu_session";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

export type SessionPayload = {
  uid: string;
  sub: string | null;
  role: Role;
  branchId: string | null;
  name: string;
  iat: number;
  exp: number;
};

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64urlDecode(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

// SESSION_SECRET is the canonical name; the aliases let a deployment that
// named the variable differently still resolve. Checked in priority order.
export const SESSION_SECRET_ENV_NAMES = [
  "SESSION_SECRET",
  "STAFF_SESSION_SECRET",
  "INTERNAL_SESSION_SECRET",
] as const;

/** Minimum length for the signing secret to count as configured. */
export const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * Resolve the session signing secret from the runtime environment. Reads
 * process.env directly at call time (server-only — never inlined at build)
 * and returns the first non-empty alias, trimmed. null when none is set.
 */
export function resolveSessionSecret(): string | null {
  for (const name of SESSION_SECRET_ENV_NAMES) {
    const raw = process.env[name];
    if (typeof raw === "string") {
      const value = raw.trim();
      if (value.length > 0) return value;
    }
  }
  return null;
}

function readSecret(): string | null {
  const secret = resolveSessionSecret();
  if (!secret || secret.length < MIN_SESSION_SECRET_LENGTH) return null;
  return secret;
}

export function isSessionConfigured(): boolean {
  return readSecret() !== null;
}

function sign(payloadEncoded: string, secret: string): string {
  return base64url(
    crypto.createHmac("sha256", secret).update(payloadEncoded).digest()
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export type SessionInput = Omit<SessionPayload, "iat" | "exp"> & {
  ttlSeconds?: number;
};

/** Encode + sign a payload into a cookie value. Returns null if no secret. */
export function encodeSession(input: SessionInput): string | null {
  const secret = readSecret();
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const payload: SessionPayload = {
    uid: input.uid,
    sub: input.sub ?? null,
    role: normalizeRole(input.role),
    branchId: input.branchId,
    name: input.name,
    iat: now,
    exp,
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

/** Verify + decode a cookie value. Returns null on any failure (no throws). */
export function decodeSession(cookieValue: string | null | undefined): SessionPayload | null {
  if (!cookieValue) return null;
  const secret = readSecret();
  if (!secret) return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot < 0) return null;
  const encoded = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  const expected = sign(encoded, secret);
  if (!constantTimeEqual(signature, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64urlDecode(encoded).toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  // Defensive: round-trip the role through normalizeRole so legacy codes
  // in older cookies (issued before the rename) hydrate as new codes.
  payload.role = normalizeRole(payload.role);
  return payload;
}

/** Read the current request's session cookie from a route handler. */
export async function readSessionFromCookies(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value ?? null;
  return decodeSession(raw);
}

export async function setSessionCookie(value: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set({
    name: COOKIE_NAME,
    value,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ttlSeconds,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
