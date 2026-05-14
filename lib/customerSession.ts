// HMAC-signed CUSTOMER session cookie. Separate from the OPS cookie in
// lib/session.ts so an operator's session can't accidentally satisfy a
// customer endpoint (and vice versa). The two cookies coexist on the
// same browser — the OPS surface uses `careu_session`, the portal uses
// `careu_customer_session`.
//
// Payload:  { customerId, phone, name?, iat, exp }
// Cookie:   base64url(JSON).base64url(HMAC-SHA256(JSON, SESSION_SECRET))
//
// We deliberately share the same SESSION_SECRET as the OPS cookie —
// rotating one rotates the other, and the path / name segregation is
// enforced by the cookie name + payload shape. The customer cookie
// carries no role / branch identifier; it's strictly identity.
//
// Server-only. Never import from a "use client" file.

import crypto from "node:crypto";
import { cookies } from "next/headers";

const COOKIE_NAME = "careu_customer_session";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — customer-facing UX

export type CustomerSessionPayload = {
  customerId: string;
  phone: string;
  name?: string | null;
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
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function readSecret(): string | null {
  const secret = process.env.SESSION_SECRET ?? "";
  if (!secret || secret.length < 16) return null;
  return secret;
}

function sign(encoded: string, secret: string): string {
  return base64url(
    crypto.createHmac("sha256", secret).update(encoded).digest()
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export type CustomerSessionInput = Omit<
  CustomerSessionPayload,
  "iat" | "exp"
> & { ttlSeconds?: number };

export function encodeCustomerSession(
  input: CustomerSessionInput
): string | null {
  const secret = readSecret();
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const payload: CustomerSessionPayload = {
    customerId: input.customerId,
    phone: input.phone,
    name: input.name ?? null,
    iat: now,
    exp,
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export function decodeCustomerSession(
  cookieValue: string | null | undefined
): CustomerSessionPayload | null {
  if (!cookieValue) return null;
  const secret = readSecret();
  if (!secret) return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot < 0) return null;
  const encoded = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  const expected = sign(encoded, secret);
  if (!constantTimeEqual(signature, expected)) return null;
  let payload: CustomerSessionPayload;
  try {
    payload = JSON.parse(
      base64urlDecode(encoded).toString("utf8")
    ) as CustomerSessionPayload;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  return payload;
}

export async function readCustomerSessionFromCookies(): Promise<CustomerSessionPayload | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value ?? null;
  return decodeCustomerSession(raw);
}

export async function setCustomerSessionCookie(
  value: string,
  ttlSeconds = DEFAULT_TTL_SECONDS
): Promise<void> {
  const store = await cookies();
  store.set({
    name: COOKIE_NAME,
    value,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ttlSeconds,
  });
}

export async function clearCustomerSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export const CUSTOMER_SESSION_COOKIE_NAME = COOKIE_NAME;
