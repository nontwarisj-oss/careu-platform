// Internal staff-account password hashing — server-only.
//
// Uses Node's built-in scrypt KDF: a memory-hard hash with no native
// dependency, so it builds cleanly on Vercel without an npm install.
//
// Stored format:  scrypt$<N>$<saltHex>$<keyHex>
// Verification is constant-time via crypto.timingSafeEqual.
//
// Never import this from a "use client" file.

import crypto from "node:crypto";

const KEY_LEN = 64;
const SALT_LEN = 16;
// N — scrypt CPU/memory cost. 2^14 with the default r=8 ≈ 16 MB, which stays
// under Node's default scrypt maxmem (32 MB) and runs in well under 100 ms —
// fast enough for an interactive login, slow enough to deter offline cracking.
const COST = 16384;

/** Hash a plaintext password into the storable `scrypt$...` string. */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = crypto.scryptSync(plain, salt, KEY_LEN, { N: COST });
  return `scrypt$${COST}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Constant-time verify a plaintext password against a stored hash. */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;

  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < 1024) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[2], "hex");
    expected = Buffer.from(parts[3], "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = crypto.scryptSync(plain, salt, expected.length, { N: cost });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}
